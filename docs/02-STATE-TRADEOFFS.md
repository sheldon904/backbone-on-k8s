# 02 — State: SQLite on a PVC, and one Postgres that is not for Hermes

The brief says: "Postgres/Redis as StatefulSets with PVCs, or stay managed — pick one and
document the tradeoff honestly."

Both framings assume the application can choose its datastore. **It cannot.** That is the
finding this document is really about.

---

## 1. What the audit actually found

There is no Postgres and no Redis on the host. There never was. From
[`00-CURRENT-STATE.md §6`](./00-CURRENT-STATE.md):

| Store | Size | Written by |
|---|---|---|
| `state.db` | 237 MB | gateway |
| `memory_store.db` | 21 MB | gateway |
| `kanban.db` | 140 KB | gateway |
| `verification_evidence.db` | 32 KB | gateway |
| `response_store.db` | 20 KB | gateway |
| `state-snapshots/`, `profiles/` | 309 MB | gateway |

Five SQLite files and two directories, **all written by one process.** `hermes-agent` opens
these with a local file path. There is no connection string, no `DATABASE_URL`, no driver
abstraction to swap. Moving Hermes to Postgres is not configuration — it is a fork of an
actively developed upstream project, and this repo's stated position
([`01-CONTAINERIZATION.md §5`](./01-CONTAINERIZATION.md)) is that it does not fork upstream.

So the decision is made for me, and the honest thing is to say so rather than present it as a
considered architectural choice.

## 2. The decision

**Hermes state stays SQLite, on a single ReadWriteOnce PVC, mounted by exactly one pod.**

**A Postgres StatefulSet is added anyway — for Keycloak and Langfuse, not for Hermes.**

That split is the interesting part. Phase 4 introduces Keycloak and Phase 5 introduces
Langfuse; both genuinely require Postgres and both are stateless-with-external-DB by design.
So the cluster ends up with a Postgres that the primary workload does not use. Stating that
plainly is better than either pretending Hermes uses it or pretending the cluster does not
need one.

## 3. What SQLite-on-a-PVC costs

These are constraints, not inconveniences. Each one closes off something a reviewer might
otherwise assume works.

| Constraint | Consequence |
|---|---|
| **RWO volume, single mount** | The gateway is `replicas: 1`, permanently. Not "1 for now" |
| **`Recreate`, not `RollingUpdate`** | Every deploy is a full outage of the length of a pod restart. `RollingUpdate` would try to start pod N+1 while pod N still holds the volume — it would hang on `Multi-Attach`, or worse, on a filesystem that permits it, corrupt the database |
| **No horizontal scale** | Load is handled by making the pod bigger, and nothing else |
| **No read replicas** | The dashboard reads the same files the gateway writes. Under Kubernetes it cannot, unless it is in the same pod — see §5 |
| **Backup is filesystem-level** | `pg_dump` has no analogue. A consistent copy needs either the writer quiesced or SQLite's own backup API. `cp` on a live WAL-mode database yields a torn file |
| **Node affinity is implicit** | A `local-path` PVC binds to one node. That node becomes a single point of failure and the pod cannot be rescheduled off it |

### The one that is easy to get wrong

`ReadWriteOnce` means *one node*, not *one pod*. Two pods **on the same node** can both mount an
RWO volume. So `RollingUpdate` does not reliably fail loudly — on a single-node k3s it may
happily start the new pod with both processes writing the same SQLite file. SQLite's locking is
advisory and cross-process within a host, so it would mostly work, until a WAL checkpoint
happens under contention.

This is why `strategy: Recreate` is set explicitly on the gateway Deployment with a comment,
rather than left to default. **UNVERIFIED** — I have not reproduced the corruption; the claim
here is about the documented semantics of RWO and SQLite WAL, not an experiment I ran.

## 4. Options considered

| Option | Verdict |
|---|---|
| **SQLite on PVC** (chosen) | Zero application change. Accepts singleton. Honest about it |
| **Migrate Hermes to Postgres** | Requires forking upstream. The 237 MB `state.db` has FTS5 and trigram indexes with no direct Postgres equivalent — `tsvector` is not a drop-in for FTS5 trigram matching. Rejected on cost, not on principle |
| **Litestream / LiteFS replication** | Litestream gives continuous streaming backup to object storage and is genuinely attractive for the backup problem. It does **not** give multi-writer, so it does not relax the singleton constraint. **Deferred, not rejected** — it is the strongest candidate for improving the backup story, tracked as an open item |
| **`hostPath` instead of a PVC** | Simpler on single-node k3s and pins the data to a node just as effectively, while giving up every migration path. Rejected |
| **Managed Postgres (DO)** | Would cost money monthly and still not help Hermes, which cannot use it |

## 5. The dashboard problem

`hermes-dashboard` reads the gateway's files directly. It is a separate systemd unit today only
because both processes share a filesystem.

Under Kubernetes that is no longer free. The options:

1. **Same pod, second container**, sharing the PVC mount. Keeps it working exactly as today.
   Costs: dashboard and gateway now restart together, and the dashboard inherits the gateway's
   singleton-ness.
2. **Separate Deployment with `ReadWriteMany`.** Needs an RWX-capable storage class — NFS,
   Longhorn, or similar. k3s's default `local-path` provisioner is RWO only. Real infrastructure
   cost for a read-only UI.
3. **Drop it from the cluster**, keep reaching it by tunnel as today.

**Chosen: option 1**, dashboard as a second container in the gateway pod.

It is the only one that costs nothing and changes no behaviour. It is also the one that makes
the Phase 4 SSO story concrete: the dashboard is the single HTTP surface with a UI, so it is
what goes behind oauth2-proxy — and being in the gateway pod means the oauth2-proxy sidecar
protects it without a network hop.

The cost is stated: **restarting the gateway restarts the dashboard.** For a personal system
where the gateway restart is already a full outage, that is not a real loss.

## 6. Sizing

From the audit: `~/.hermes` is 9.4 GB, but 8.0 GB of that is the `hermes-agent` checkout and its
venv — **code, which now lives in the image, not on the volume.**

| | |
|---|---|
| Actual state today | ~1.4 GB (`state.db` 237 MB + snapshots 192 MB + profiles 117 MB + backups 712 MB + the rest) |
| Backups on the volume | 712 MB — should move off-volume; see §7 |
| State excluding backups | ~690 MB |
| Growth driver | `state.db`, which is message history plus FTS indexes |

**PVC: 20 GiB.** Roughly 25× current non-backup state. `local-path` does not support online
expansion, so under-provisioning means a migration, and over-provisioning on a disk that
already has 20 GB free costs nothing until it is used.

**Growth rate is UNVERIFIED.** A single point-in-time measurement cannot give one. The right
move is a Prometheus gauge on volume usage from day one (Phase 5) and a revisit after a month
of real data.

## 7. Backup

The current design has backups on the same disk as the data — 712 MB in `~/.hermes/backup*`.
That is not a backup; it survives file deletion and nothing else.

Under Kubernetes:

- A `CronJob` mounting the same PVC **read-only**, producing a consistent snapshot via SQLite's
  `.backup` (not `cp`, which tears a WAL-mode file), pushing to off-cluster object storage.
- Retention policy in [`RETENTION.md`](./RETENTION.md).
- The CronJob mounting RWO read-only while the gateway holds it read-write **works only if both
  land on the same node.** On single-node k3s that is automatic. On a multi-node cluster it
  needs `nodeAffinity` matching the volume. Called out because it is the kind of thing that
  works in dev and fails the first time a second node exists.

## 8. Open items

| # | Item |
|---|---|
| S1 | Measure `state.db` growth over a month; revisit the 20 GiB PVC |
| S2 | Evaluate Litestream for continuous backup — strongest candidate, deferred not rejected |
| S3 | Confirm whether hermes-agent's SQLite handles are WAL or rollback-journal; determines whether the read-only backup mount is safe at all |
| S4 | Decide where Postgres for Keycloak/Langfuse lives — in-cluster StatefulSet (chosen for now) vs. managed. Revisit if it turns out to need real availability |

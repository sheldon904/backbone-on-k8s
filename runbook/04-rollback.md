# 04 — Rollback and teardown

Three different operations, in increasing severity. Pick the smallest one that fixes the
problem.

---

## 1. Roll back a bad release

```bash
helm history backbone -n backbone
helm rollback backbone <REVISION> -n backbone
kubectl -n backbone rollout status deploy/backbone-gateway --timeout=240s
```

**The gateway uses `strategy: Recreate`, so a rollback is a brief full outage** — the old pod
must release the RWO volume before the new one starts. That is deliberate: `RollingUpdate` would
co-schedule two writers on one SQLite database. See
[`docs/02-STATE-TRADEOFFS.md`](../docs/02-STATE-TRADEOFFS.md) §3.

`helm rollback` restores manifests, **not data**. If the bad release corrupted the state volume,
restore from a backup (§4) instead.

## 2. Back out one control without a full rollback

Each is independently switchable, which is the point of the values structure:

```bash
helm upgrade backbone charts/backbone -n backbone --reuse-values --set networkPolicy.enabled=false
helm upgrade backbone charts/backbone -n backbone --reuse-values --set sso.enabled=false
helm upgrade backbone charts/backbone -n backbone --reuse-values --set gateway.dashboard.enabled=false
```

> Watch `--reuse-values` here — it will drop any chart key added since the last release (F9).
> If a resource unexpectedly disappears, that is why.

**Do not disable `networkPolicy` as a debugging reflex.** If something cannot reach something
else, the likely cause is a missing *egress* rule on the source (F6), not the policy set as a
whole. Confirm with a positive control before turning off the security posture.

## 3. Uninstall the release, keep the data

```bash
helm uninstall backbone -n backbone
```

Two PVCs carry `helm.sh/resource-policy: keep` and **survive this deliberately**:

| PVC | Contains |
|---|---|
| `backbone-gateway-state` | every SQLite store — message history, memory, tasks |
| `backbone-notify-mcp-audit` | the hash-chained audit stream |

Reinstalling against them:

```bash
helm install backbone charts/backbone -n backbone \
  --set gateway.persistence.existingClaim=backbone-gateway-state
```

To actually delete the data you must be explicit:

```bash
kubectl -n backbone delete pvc backbone-gateway-state backbone-notify-mcp-audit
```

`kubectl delete namespace backbone` deletes the PVCs too. There is no confirmation.

## 4. Restore state from backup

The `backup` CronJob writes dated directories under `backups/` **on the same volume as the
data** — a copy, not a backup. It survives accidental deletion and nothing else.

```bash
kubectl -n backbone scale deploy/backbone-gateway --replicas=0    # single writer: stop it first
kubectl -n backbone run restore --rm -it --image=backbone/hermes-gateway:dev \
  --overrides='{"spec":{"containers":[{"name":"restore","image":"backbone/hermes-gateway:dev",
    "command":["sh"],"stdin":true,"tty":true,
    "volumeMounts":[{"name":"state","mountPath":"/home/hermes/.hermes"}]}],
    "volumes":[{"name":"state","persistentVolumeClaim":{"claimName":"backbone-gateway-state"}}]}}'
# inside: cp backups/<date>/*.db .
kubectl -n backbone scale deploy/backbone-gateway --replicas=1
```

**Scale to zero first.** Restoring under a live writer is how you get a corrupted database
instead of a restored one.

## 5. Full teardown

```bash
# 1. CAPTURE EVIDENCE FIRST — see 02-install.md Step 11.
#    After this point the cluster is unreproducible except from this runbook.

# 2. Keep the sealed-secrets controller key, encrypted, off-cluster.
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml \
  > sealed-secrets-key-$(date +%F).yaml

# 3. Export state if it is the authoritative copy.
kubectl -n backbone exec deploy/backbone-gateway -c gateway -- \
  tar cz -C /home/hermes/.hermes . > backbone-state-$(date +%F).tgz

# 4. Then destroy.
/usr/local/bin/k3s-uninstall.sh
# ...and delete the droplet. Billing is hourly; destroying stops it.
```

### What must survive teardown

| | Why |
|---|---|
| `evidence/<date>/` | The only proof the deployment existed |
| The sealed-secrets controller key | Without it every committed `.sealed.yaml` is permanently undecryptable |
| The state export, if authoritative | Message history and memory |
| `docs/OPERATIONS.md` | The incident record — the most valuable output |

### If the cluster was temporary, say so

A torn-down cluster whose README still claims continuous operation is worse than never having
built it. Update the lifecycle row in the README to what actually happened: migrated, validated,
torn down for cost, reproducible from this runbook in ~25 minutes.

That is a defensible position. An inaccurate one is not.

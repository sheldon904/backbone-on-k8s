# 01 — Prerequisites

## 1. Host sizing

**8 GB / 4 vCPU minimum** for the full stack. Measured on the reference install:

| Component | Resident |
|---|---|
| k3s server (API, scheduler, controller, containerd, kubelet) | ~700 MB |
| Cilium agent + operator + Hubble relay | ~400 MB |
| Backbone workload (gateway 1 Gi limit, 2× notify-mcp, ntfy) | ~1.6 GB |
| sealed-secrets controller | ~50 MB |
| Keycloak + its Postgres *(if SSO enabled)* | ~1 GB |
| Prometheus + Grafana *(if monitoring enabled)* | ~600 MB |
| **Total** | **~4.3 GB** |

4 GB works only without Keycloak and Prometheus. It will swap otherwise, and Kubernetes
memory limits stop meaning anything once the node swaps — provision the node with **swap off**,
which is also what kubelet expects by default.

**Disk:** 40 GB is comfortable. The reference install used ~12 GB including both images
(notify-mcp 235 MB, hermes-gateway 541 MB) and a 20 Gi state PVC that is mostly empty.

## 2. Before you start, have these

| | Why |
|---|---|
| An SSH keypair, public half added at droplet creation | Password auth emails a plaintext root password, and this host will hold a copy of your message history |
| The upstream tag you are pinning | **Not** the version `hermes --version` prints. That is a product version; upstream tags are date-based. `v0.18.0` → the tag is `v2026.7.1` |
| A Tailscale auth key *(optional but recommended)* | Gives real LetsEncrypt certs on `<host>.<tailnet>.ts.net` with no DNS records and no public exposure |
| A **separate** Telegram bot token, if migrating alongside a running instance | The adapter uses `getUpdates` long-polling; two pollers on one token 409 each other. See §4 |

## 3. Cilium is not optional

**k3s ships flannel. Flannel does not implement NetworkPolicy.** Every policy in
`charts/backbone/templates/networkpolicy.yaml` will be accepted by the API server and silently
enforced by nothing.

Install k3s with the CNI disabled:

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="\
  --flannel-backend=none \
  --disable-network-policy \
  --write-kubeconfig-mode 644" sh -
```

`--disable-network-policy` removes k3s's own policy controller so Cilium owns enforcement
outright. **The node will sit `NotReady` until Cilium is installed — that is expected**, not a
failure. Nothing schedules without a CNI.

Verify enforcement is real before trusting it:

```bash
kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg endpoint list
# every backbone endpoint should show POLICY (ingress) ENFORCEMENT = Enabled
```

## 4. If you are migrating alongside a running instance

The source system keeps running during the migration. Four things will collide unless you stop
them, and none of them fail loudly:

| Collision | Consequence | Guard |
|---|---|---|
| Same **Telegram bot token** | `getUpdates` 409s; one gateway is silently evicted, nondeterministically | Use a second bot |
| Same **Photon/iMessage** credentials | Duplicate relay consumers | Blank `PHOTON_*` on the new cluster |
| Same **backup repo URL** | The new instance holds a point-in-time copy and can push staler state over the canonical backup | Blank `GITHUB_BACKUP_REPO_URL` |
| Same **cron jobs enabled on both** | Double-processing; anything client-facing fires twice | A job runs on exactly one side, never both |

The rule that keeps this safe: **a workflow runs on exactly one side.** Decide per job, and
write down which side owns it.

> **The trap that catches people who did all of the above.** Those four guards are applied to
> *credentials*. The scheduler's job table is **state**, and restoring it hands the new instance
> every job you just carefully de-conflicted — through a completely different door. After any
> state restore, re-check what the scheduler thinks it should run:
>
> ```bash
> kubectl -n backbone exec deploy/backbone-gateway -c gateway -- python -c "
> import json; d=json.load(open('/home/hermes/.hermes/cron/jobs.json'))
> [print(j['name'], j.get('enabled')) for j in d['jobs']]"
> ```
>
> Restoring state restores *behaviour*. For an agent, a database is not inert.

## 5. Data you will need to move

From the source host, snapshotted with SQLite's online backup API — **never `cp`**, the
databases are WAL-mode with a live writer and `cp` silently loses the WAL:

```python
import sqlite3, pathlib
src = pathlib.Path.home()/'.hermes'; out = pathlib.Path('/tmp/state'); out.mkdir(exist_ok=True)
for db in src.glob('*.db'):
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as s, sqlite3.connect(out/db.name) as d:
        s.backup(d)
```

Measured: 249 MB `state.db` + 22 MB `memory_store.db` + three smaller stores. The 22 MB store
snapshots in **0.18 s** against a live writer, `integrity_check ok`.

Also required, and easy to miss because they are **not** in `.env`:
`google_token.json`, `google_client_secret.json`, `ga4-service-account.json`, `auth.json`.
A migration that copies only `.env` loses these, and the symptom is a Google integration that
fails at first use rather than at startup.

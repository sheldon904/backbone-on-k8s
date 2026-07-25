# Validation

What has actually been observed, what CI proves, and what still requires a live cluster.

This file is maintained from the first commit, not written at the end. Rows move **up** as
evidence arrives. A capability that is not in section 1 or 2 is not a capability this repo
claims — regardless of how complete the code for it looks.

**Environment note.** The authoring environment is the source droplet itself: 1 vCPU, 1.9 GiB
RAM, no Docker, no Kubernetes, no cluster access. That is why several rows that would normally
be trivial to verify sit in section 3. It is a real constraint, not an excuse — see
[§4 Why this environment cannot verify more](#4-why-this-environment-cannot-verify-more).

Last updated: 2026-07-25.

---

## 1. Verified locally

Each row names the command and the observed result.

| # | Claim | Command | Result |
|---|---|---|---|
| L1 | The host runs no container runtime | `which docker podman containerd` | no output; `docker ps` → `command not found` |
| L2 | 8 Hermes-related processes, 3 duplicate MCP children | `ps -eo pid,ppid,user,rss,comm,args --sort=-rss` | topology in [`docs/00-CURRENT-STATE.md#3`](docs/00-CURRENT-STATE.md) |
| L3 | The backbone MCP registers exactly one tool | `grep "MCP server 'backbone'" ~/.hermes/logs/agent.log` | `registered 1 tool(s): mcp_backbone_notify` |
| L4 | `packages/governance` passes its own tests | `pnpm -r test` in `~/Backbone` | **57 passed** across 7 files (vitest 3.2.4) |
| L5 | The installed gateway unit is not the hardened one | `systemctl cat hermes-gateway` | no `Protect*`, no `NoNewPrivileges`, no `MemoryMax`, `StartLimitIntervalSec=0` |
| L6 | Five SQLite stores, single-writer, 237 MB largest | `sqlite3` read-only table dump + `du -sh` | table lists in [`docs/00-CURRENT-STATE.md#6`](docs/00-CURRENT-STATE.md) |
| L7 | 10 in-process cron jobs, 8 enabled | `~/.hermes/cron/jobs.json` | listed in [`docs/00-CURRENT-STATE.md#7`](docs/00-CURRENT-STATE.md) |
| L8 | Public exposure is Tailscale Funnel, not an ingress controller | `tailscale serve status` | 3 Funnel paths; dashboard loopback-only |
| L9 | No SSO on any surface today | `config.yaml`: `dashboard.oauth.client_id`, `dashboard.basic_auth.username` | both empty strings |

## 2. Verified in CI

CI runs on GitHub Actions, which has the Docker, Helm and Kubernetes tooling this droplet does
not. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

| # | Claim | Job | Result |
|---|---|---|---|
| — | *(nothing yet — CI not written as of this commit)* | | |

## 3. Requires the live cluster — not done

These are unproven. No document in this repo may state them as fact.

| # | Claim | Blocked on |
|---|---|---|
| C1 | The full stack comes up under Compose and passes a healthcheck | a machine with Docker |
| C2 | `kubectl get pods` shows everything Running on k3s | a 4–8 GB VM with k3s |
| C3 | `helm install` on a fresh namespace reproduces the plain manifests | same |
| C4 | A disallowed pod-to-pod connection is actually refused | k3s **plus a CNI that enforces NetworkPolicy** — k3s ships flannel, which does not |
| C5 | Login succeeds through Keycloak + oauth2-proxy | live cluster + DNS + TLS |
| C6 | Sealed-secrets round-trips a real secret and survives a controller restart | live cluster |
| C7 | Grafana panels move when the system is used | live cluster + a real workload |
| C8 | Daily workflows run on the cluster for 7 consecutive days | Phase 6, the actual point of the project |
| C9 | `docs/OPERATIONS.md` contains real incidents | can only be earned by operating it |

## 4. Why this environment cannot verify more

| Wanted | Blocker |
|---|---|
| `docker build` / `docker compose up` | no container runtime installed; installing one on the live agent host was explicitly out of scope for this work |
| `kind` / `k3s` locally | 1 vCPU / 1.9 GiB, 762 MiB available, already swapping (178 MiB used). A control plane plus this workload does not fit |
| `kubectl apply` | no cluster |

Helm and kubeconform are static single binaries with no daemon, so those **can** be run here and
their results appear in section 1 as they are produced.

## 5. Deviation from the original brief

The brief says to stop at each phase gate and wait for the operator to observe something
running. **That has not been done, deliberately and on instruction.** The operator's direction
for this build was to produce the full artifact set without provisioning paid infrastructure.

Every phase gate is therefore **unmet**, and each is listed in section 3. The artifacts for a
phase existing is not the same as that phase's gate passing, and this repo does not conflate
the two anywhere.

| Phase | Gate | Status |
|---|---|---|
| 0 | Operator confirms the inventory is accurate | **awaiting operator review** |
| 1 | Full stack up under Compose, healthcheck green | unmet — C1 |
| 2 | `kubectl get pods` all Running, gateway reachable | unmet — C2 |
| 3 | `helm install` reproduces Phase 2 | unmet — C3 |
| 4 | Keycloak login works; disallowed connection refused | unmet — C4, C5 |
| 5 | Dashboard numbers move under real use | unmet — C7 |
| 6 | 7 consecutive days of real workflows | unmet — C8 |

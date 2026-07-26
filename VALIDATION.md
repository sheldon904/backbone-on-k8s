# Validation

What has actually been observed, what CI proves, and what still requires a live cluster.

This file is maintained from the first commit, not written at the end. Rows move **up** as
evidence arrives. A capability that is not in section 1 or 2 is not a capability this repo
claims — regardless of how complete the code for it looks.

**Environment note.** The authoring environment is the source droplet itself: 1 vCPU, 1.9 GiB
RAM, no Docker, no Kubernetes, no cluster access. That is why several rows that would normally
be trivial to verify sit in section 3. It is a real constraint, not an excuse — see
[§4 Why this environment cannot verify more](#4-why-this-environment-cannot-verify-more).

Last updated: 2026-07-25. **38 verified locally, 8 in CI, 23 on a live cluster, 9 still open.**

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
| L10 | notify-mcp compiles clean and its tests pass | `npx tsc && node --test dist/*.test.js` | **22/22 pass**, tsc exit 0 |
| L11 | The HTTP MCP transport answers `initialize` **and repeated** `tools/list` | `curl -X POST /mcp` x3, see `scripts/healthcheck.sh` | `serverInfo` returned; `notify` tool listed on requests 2 and 3 |
| L12 | `tools/call notify` delivers end to end | server pointed at a local HTTP sink, `tools/call` with `action=reminder` | sink received `POST /local-test`, headers `Title/Priority/Tags/Click`, body `pod smoke test`; result `{"ok":true,"delivered":{"ntfy":true}}` |
| L13 | The `Click` deep-link round-trips a reminder payload | same run, decoded the sink's `Click` header | `shortcuts://run-shortcut?name=Backbone%20Notify%20Bridge&...` decoding to `{action:reminder,title,due}` |
| L14 | `/metrics` moves when the tool is used | `curl /metrics` before and after | `backbone_notify_total 0` → `1`; `channel_total{ntfy,ok} 1`, `{telegram,fail} 1` |
| L15 | `/readyz` returns 503 with no channel configured | `readiness(configFromEnv({}))` + unit test | 503 `no delivery channel configured` |
| L16 | `scripts/healthcheck.sh` is syntactically valid and correctly reports partial stacks | `bash -n`; then run against notify-mcp only | 5 notify checks ok, ntfy FAIL, gateway **skip** (correctly not claimed) |
| L17 | No NUL bytes in tracked source | `grep -rlP '\x00' --include='*.ts' --include='*.json' --include='*.md' .` | no output |
| L18 | Manifests are valid Kubernetes | `kubeconform -strict -kubernetes-version 1.31.0 manifests/` | **15 resources, 0 invalid** |
| L19 | SQLite online `.backup` is consistent against a **live** writer | `s.backup(d)` against `~/.hermes/memory_store.db` while the gateway held it open | source `journal_mode=wal`; copy `integrity_check ok`, 25 tables, `facts 1593 / entities 921 / edges 3239`, 22 MB in **0.18 s** |
| L20 | Chart lints and renders | `helm lint` + `helm template` | lint 0 failed; **23 resources** at defaults |
| L21 | Chart renders across 4 Kubernetes versions and 3 value sets | `helm template \| kubeconform` for 1.29–1.32; `ci/*.yaml` | all valid; minimal 7, existing-claim 22, full-controls 26 resources |
| L22 | Exposing the dashboard without SSO is **refused**, not warned | `helm template --set ingress.exposeDashboard=true` | template fails with the reason |
| L23 | Chart and manifests agree on every correctness constraint | `./scripts/parity-check.sh` | **21/21 ok** |
| L24 | Every rendered container satisfies `restricted` PSS | parity-check | `allowPrivilegeEscalation: false` and `drop: [ALL]` on all containers; no `runAsUser: 0`; `RuntimeDefault` on every pod |
| L25 | Default-deny covers **both** directions, and metadata is blocked | parity-check, parsing the NetworkPolicy | `policyTypes: [Ingress, Egress]` with empty `podSelector`; `169.254.0.0/16` in the egress `except` list |
| L26 | The chart never templates a Secret | parity-check | 0 `kind: Secret` in rendered output; no `secrets.values` map |
| L27 | Grafana dashboard is valid JSON, every panel has a query | `json.load` + panel walk | 14 panels / 5 rows, 0 panels without a query |
| L28 | No "recall latency" anywhere | regex over the dashboard JSON | appears only in the description explaining its deliberate absence; **0 queries reference it** |
| L29 | Full static suite passes end to end | `./scripts/validate.sh` | `ALL STATIC CHECKS PASSED`, exit 0 |
| L30 | hermes-agent supports an **HTTP MCP transport natively** — no shim needed | read `tools/mcp_tool.py` in the running checkout | accepts `url`, `transport`, `headers`, `type` alongside stdio `command`/`args`; imports `streamablehttp_client` and `sse_client` |
| L31 | The bundled Langfuse plugin wants `HERMES_LANGFUSE_*`, not bare `LANGFUSE_HOST` | read `plugins/observability/langfuse/` + `hermes_cli/config.py` | plugin exists; env names are `HERMES_LANGFUSE_{BASE_URL,PUBLIC_KEY,SECRET_KEY,SAMPLE_RATE}`. **The chart was injecting names the plugin ignores** — fixed |
| L32 | hermes-agent exposes **no** Prometheus endpoint | `grep -rniE 'prometheus\|/metrics' --include='*.py'` | no match — confirms the largest observability gap is real |
| L33 | Recall latency **is** a metric of this system, not another project | `memory_store.db` | `recall_log` table, **2725 rows**, live; `plugins.hybrid.recall_log_enabled: true` |
| L34 | notify-mcp emits an **append-only hash-chained JSONL audit stream** | `node --test dist/audit.test.js` | **13/13 pass**; edit / delete / head-truncation each detected at the correct line |
| L35 | The chain **resumes** across a restart rather than resetting `seq` | same suite | new instance on an existing file continues at seq 3, chain still valid |
| L36 | Two replicas keep independent, independently-verifiable chains | same suite | per-pod files both verify |
| L37 | An unwritable audit path **fails fast** and never spins | same suite | `chmod 0500` dir and procfs both return null in <2 s (previously hung forever — docs/OPERATIONS.md) |
| L38 | Full notify-mcp suite | `node --test dist/*.test.js` | **35/35 pass, 1.4 s** |

## 2. Verified in CI

CI runs on GitHub Actions, which has the Docker, Helm and Kubernetes tooling this droplet does
not. Rows below are from run
[`30169059862`](https://github.com/sheldon904/backbone-on-k8s/actions/runs/30169059862) —
**all 4 jobs green**.

| # | Claim | Job | Result |
|---|---|---|---|
| CI1 | notify-mcp typechecks, builds and passes its tests on clean Linux | `notify-mcp` | `tests 22 / pass 22 / fail 0` |
| CI2 | The HTTP transport answers `initialize` then `tools/list` **three times** | `notify-mcp` | `OK — transport is genuinely stateless` |
| CI3 | The notify-mcp image builds | `images` | built |
| CI4 | The runtime image has **no shell** and runs as uid 65532 | `images` | `runs as uid 65532` · `OK — no shell, non-root` — asserted by exec'ing `/bin/sh` and requiring failure |
| CI5 | The built image serves MCP over HTTP in a container | `images` | `OK — the built image serves MCP` |
| CI6 | Manifests + chart validate, parity holds | `manifests` | `Valid: 16, Invalid: 0` (manifests), `Valid: 22, Invalid: 0` (rendered chart), `PARITY OK`, `ALL STATIC CHECKS PASSED` |
| CI7 | Chart renders on Kubernetes 1.29 / 1.30 / 1.31 / 1.32 | `manifests` | all four valid |
| **CI8** | **The hermes-gateway image builds** | `images` | **built** — `applying 0001-cron-memory-opt-in.patch` → `Checking patch cron/scheduler.py...` → image `365,353,842 bytes, user: 10001:10001`. Took two runs; the first failed on a wrong upstream ref (docs/OPERATIONS.md) |

## 2b. Verified on a live cluster — 2026-07-25

k3s v1.36.2 + **Cilium 1.16.5** (flannel disabled — it cannot enforce NetworkPolicy) on an
8 GB droplet. Raw output in [`evidence/2026-07-25/`](evidence/2026-07-25/).

| # | Claim | Result |
|---|---|---|
| K1 | Both images build on a clean machine | notify-mcp 235 MB, hermes-gateway 541 MB |
| K2 | **Compose stack comes up on a VPS and passes the healthcheck** | all 3 services up, `healthcheck.sh` **GREEN** on 7/7 — closes C1, C12 |
| K3 | `kubectl get pods` all Running | gateway, 2x notify-mcp, ntfy — 0 restarts — closes C2 |
| K4 | `helm install` from scratch reproduces the manifests | revision 1 clean install — closes C3 |
| K5 | **A disallowed pod-to-pod connection is refused** | probe → ntfy and → notify-mcp both `HTTP 000`, curl 28 timeout — closes C4 |
| K6 | ...and an **allowed** one still works | gateway → notify-mcp `/healthz` 200, MCP `tools/list` returns the notify tool |
| K7 | **sealed-secrets round-trips** | 41 keys sealed with `kubeseal`, controller decrypted them into a live Secret — closes C6 |
| K8 | **`readOnlyRootFilesystem: true` holds for the gateway** | `ready=true restarts=0`, **0 read-only errors** after mounting `.local` — closes C11 |
| K9 | The gateway reaches OpenRouter with the real key | HTTP 200, **345 models** visible |
| K10 | **Full path: gateway → notify-mcp → ntfy** | `ok:true`, ntfy HTTP 200, message id `MPFNTu0FR8QF` |
| K11 | **The audit stream writes to a retention-managed volume** | 5 Gi PVC bound; both replicas' `audit-<pod>.jsonl` present |
| K12 | **The hash chain verifies on-cluster** | both files `VALID=true`, first line `prevHash=0000…` (GENESIS) |
| K13 | Pod Security Admission `restricted` is enforcing | a non-compliant probe pod was refused by the API server |
| K14 | Cilium reports policy enforcement on every backbone endpoint | `ingress=both` (ingress+egress) on all 4 |
| K15 | **The dashboard runs** — web assets built in-image | `dashboard: ready=true restarts=0`; log: `using dist at .../hermes_cli/web_dist`. Four containers healthy: gateway, dashboard, 2x notify-mcp, ntfy |
| K20 | **Recall latency is live on the cluster** | `backbone_recall_latency_seconds` — 4 probes, sum 0.0153 s, ~3.8 ms mean, **0 failures**, against the restored 22 MB memory store |
| K21 | **Workflow success rate is live** | `backbone_workflow_runs_total` — gmail-intake 2,895 · memory-ingest 2,352 · calendar-sync 9,847, from the restored scheduler table |
| K22 | **Cost per task is live** | 1,111 sessions, $8.52 estimated → **$0.00767/task**; 231 M cache-read vs 74.7 M input tokens |
| K23 | The memory substrate reads on-cluster | facts 1,604 · entities 929 · edges 3,254 · recall events 2,727 |
| K17 | **A real OIDC login succeeds through Keycloak** | 5-step authorization-code flow: 302 → login form → code issued → `_oauth2_proxy` session cookie → dashboard HTTP 200. Closes C5 |
| K18 | The dashboard is **unreachable without auth** | unauthenticated `GET /` → 302 to Keycloak, never the dashboard |
| K19 | `--cookie-secure=true` is genuinely enforcing | with the production default, the same flow is **refused** over plain http: `CSRF cookie '_oauth2_proxy_csrf' was not found` → 403 |
| K16 | **The runbook is written from a real install** | [`runbook/`](runbook/) — prerequisites, install, 10 failure modes, rollback. Every failure listed occurred during the reference run |

## 3. Requires the live cluster — not done

These are unproven. No document in this repo may state them as fact.

| # | Claim | Blocked on |
|---|---|---|
| C7 | Grafana panels move when the system is used | live cluster + a real workload |
| C8 | Daily workflows run on the cluster for 7 consecutive days | Phase 6, the actual point of the project |
| C9 | `docs/OPERATIONS.md` contains real incidents | can only be earned by operating it |
| C14 | `config.yaml` is assembled at startup from ConfigMap + Secret | **not implemented.** hermes-agent reads one config.yaml; an init container or startup wrapper has to compose it. A real gap, not a detail — docs/04-SECRETS.md §3 |
| C15 | Langfuse actually receives a trace | the plugin and the env names are now confirmed (L31); whether traces arrive needs a running gateway plus a Langfuse instance |
| C16 | NetworkPolicy is **enforced** | k3s ships flannel, which does not enforce NetworkPolicy at all. Needs `--flannel-backend=none --disable-network-policy` plus Calico or Cilium. Until then the policies are accepted by the API server and enforced by nothing |
| C17 | Sealed-secrets key rotation | the controller supports it; nothing in this repo drives it |
| C18 | etcd encryption at rest | off by default on k3s; `--secrets-encryption` is a bootstrap flag, out of scope for the chart |
| C19 | The gateway image reproduces the **running** system | only 1 of 3 local patches to upstream is vendored. `plugins/memory/holographic/store.py` (a transaction-leak fix) and `tools/memory_tool.py` (archival overflow) are not. An image built today is missing both — docs/00-CURRENT-STATE.md §12 |

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

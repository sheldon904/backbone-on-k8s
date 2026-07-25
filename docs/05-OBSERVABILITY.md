# 05 — Observability

The brief names four metrics: proposal→approval latency, policy-gate decisions
(allowed/denied/replayed), workflow success rate, cost per task. And one prohibition: **do not
use "recall latency"** — that belongs to a different project and means nothing here.

Two of those four measure a subsystem that is not running. This document says which, and what
is measured instead.

---

## 1. The four requested metrics, checked against reality

| Requested | Can it be measured today? |
|---|---|
| **proposal → approval latency** | **No.** Requires the governance gate's proposal state machine, which was removed on 2026-05-24 ([`00-CURRENT-STATE.md §2`](./00-CURRENT-STATE.md)). There are no proposals, so there is no latency between their states |
| **policy-gate decisions (allowed / denied / replayed)** | **No.** Same reason. `packages/governance` implements exactly these three outcomes and passes 57 tests; nothing calls it |
| **workflow success rate** | **Yes** — cron jobs and tool calls both produce success/failure, and `kanban.db` has `task_runs` |
| **cost per task** | **Yes** — OpenRouter returns token usage and cost per request; the dashboard already has `show_token_analytics: true` |

Building panels for the first two would mean building panels that display a constant zero. The
dashboard ships with **the two that are real**, plus panels for what actually constrains this
system — and it ships with the other two **defined but disabled**, so that re-wiring the gate
turns them on rather than requiring them to be invented.

That is the honest version of "instrument the four metrics".

## 2. What is instrumented, and where it comes from

| Signal | Source | Status |
|---|---|---|
| `backbone_notify_total` | notify-mcp `/metrics` | **implemented and verified** — L14 |
| `backbone_notify_failed_total` | notify-mcp | implemented and verified |
| `backbone_notify_channel_total{channel,outcome}` | notify-mcp | implemented and verified |
| `backbone_notify_duration_ms` (histogram) | notify-mcp | implemented and verified |
| `backbone_tool_errors_total` | notify-mcp | implemented |
| `backbone_uptime_seconds` | notify-mcp | implemented |
| Pod restarts, OOM kills, CPU/memory | kube-state-metrics + cAdvisor | standard, not written here |
| Volume free space | kubelet volume stats | standard |
| Cron job success/failure | kube-state-metrics on the CronJobs | standard |
| Token cost per request | Langfuse | **not implemented** — see §4 |
| Workflow success rate | hermes-agent | **not implemented** — hermes-agent exposes no Prometheus endpoint |

### The gap worth naming

**hermes-agent has no `/metrics` endpoint.** Every gateway-level signal in the dashboard is
therefore inferred from outside — pod restarts, container memory, CronJob completion — rather
than reported by the application.

Closing it means either a sidecar that parses `agent.log` into metrics (fragile, log formats
change), or a contribution upstream (correct, slower). Neither is done. It is the single largest
observability gap and it is not hidden behind a panel that looks like it works.

## 3. Why these panels and not others

The dashboard is built around what can actually go wrong here, which is a short list because
the system is small:

1. **The gateway is a singleton.** It being down is a total outage, and it cannot be scaled to
   mitigate. So: restart count, availability, and memory headroom against the 1 GiB limit, which
   is the thing that killed the droplet before a swapfile was added.
2. **Notifications are how the system talks to its operator.** If both channels fail, the system
   is not just degraded, it is *silent* — it cannot tell anyone it is broken. So: per-channel
   success rate, and an alert specifically for all-channels-failing.
3. **The state volume cannot be expanded online.** `local-path` has no resize. Running out means
   a migration. So: free space with weeks of runway, not hours.
4. **CrashLoopBackOff retries forever.** systemd's `StartLimitBurst` gives up and goes quiet;
   Kubernetes does not. Nothing escalates on its own, so the restart-loop alert *is* the
   replacement for that behaviour.

## 4. Langfuse

Tracing is wired as configuration (`tracing.enabled` in `values.yaml`), which injects
`LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` into the gateway.

**Whether hermes-agent v0.18.0 reads those variables is UNVERIFIED.** The values are set
because that is the conventional Langfuse integration; if upstream does not consume them,
tracing requires a wrapper around the model client and the env vars are inert. Tracked as
[`VALIDATION.md`](../VALIDATION.md) row C15.

This is exactly the kind of claim that would otherwise read as "Langfuse tracing: done" in a
README. It is not done. It is configured, and unconfirmed.

Langfuse also needs its own Postgres — the second consumer, with Keycloak, of the Postgres that
[`02-STATE-TRADEOFFS.md`](./02-STATE-TRADEOFFS.md) adds for reasons unrelated to Hermes.

## 5. The dashboard

`observability/grafana-dashboard.json` — importable, 11 panels, no external dependencies beyond
Prometheus and kube-state-metrics.

| Row | Panels |
|---|---|
| **Availability** | gateway up/down · restarts (30 m) · uptime |
| **Notifications** | delivery rate by channel · all-channel failure count · p50/p95 fan-out latency |
| **Resources** | gateway memory vs. limit · state volume free · notify-mcp replicas ready |
| **Scheduled work** | CronJob last success age · failed job count |
| **Disabled, awaiting the governance gate** | policy-gate decisions · proposal→approval latency |

The last row is present with its queries written and `"hide": true` set, so that if the gate is
ever re-wired the panels turn on rather than needing to be reinvented. Their titles say
`(no data — governance gate not wired, see docs/RETENTION.md §5)` so nobody reads an empty
panel as a healthy zero.

## 6. Verification status

| Claim | Status |
|---|---|
| notify-mcp exposes valid Prometheus exposition | **verified** — L14, and a unit test asserts every line matches the format |
| The metrics move when the tool is used | **verified** — L14 |
| The dashboard JSON is valid and every panel has a query | **verified** — L20 |
| PrometheusRule and ServiceMonitor render and validate | **verified** — L18 |
| Grafana renders the dashboard | **not done** — C7 |
| The numbers move when the system is used on a cluster | **not done** — C7, the Phase 5 gate |
| Langfuse receives a trace | **not done** — C15 |

# 05 — Observability

The brief names four metrics: proposal→approval latency, policy-gate decisions
(allowed/denied/replayed), workflow success rate, cost per task. And one prohibition: **do not
use "recall latency"** — that belongs to a different project and means nothing here.

Two of those four measure a subsystem that is not running. This document says which, and what
is measured instead.

---

## 1. The four requested metrics, checked against reality

| Requested | Status |
|---|---|
| **proposal → approval latency** | **Not measurable.** Requires the governance gate's proposal state machine, removed 2026-05-24 ([`00-CURRENT-STATE.md §2`](./00-CURRENT-STATE.md)). There are no proposals, so there is no latency between their states. **The panel was deleted rather than shipped showing a constant zero** |
| **policy-gate decisions (allowed / denied / replayed)** | **Not measurable.** Same reason. Also deleted |
| **workflow success rate** | ✅ **live** — `backbone_workflow_runs_total{job}` from the gateway's in-process scheduler |
| **cost per task** | ✅ **live** — `backbone_cost_usd_total / backbone_sessions_total` |
| **recall latency** *(added)* | ✅ **live** — measured by a synthetic prober; see §2b |

### What the numbers actually are

Observed on the restored production corpus, 2026-07-26:

```
sessions                1,111
cost (estimated)        $8.52   ->  COST PER TASK  $0.00767
tokens  input           74,694,559
        cache_read     231,372,396      <- prompt caching working
        output           1,723,797
top models   qwen3-235b $4.62 | mimo-v2.5 $2.91 | deepseek-v4-pro $0.99
recall latency          ~3.8 ms mean, 0 probe failures
workflow runs           gmail-intake 2,895 | memory-ingest 2,352 | calendar-sync 9,847
```

**Two honesty constraints are built into the dashboard rather than left to the reader.**

`cost_status` is exported as a *label*, not collapsed away, because `actual_cost_usd` is null
across the entire corpus — every figure is `estimated`, derived from the provider's pricing API.
A cost panel that silently presents estimates as billed amounts produces a number that gets
repeated in a meeting as fact.

Recall latency is **measured, not read**. `recall_log` stores a timestamp and no duration, so
`backbone-exporter` runs a real FTS query against the live store and times it. That measures the
FTS path — it is *not* the same quantity as the five-channel figure in the hybrid-memory
research, and the panel description says so.

Building panels for the first two would mean building panels that display a constant zero, so
they are **not in the dashboard at all**. An earlier revision shipped them hidden-but-defined;
that was worse — a panel that can never have data is a promise the system cannot keep.

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
| `backbone_recall_latency_seconds` (histogram) | backbone-exporter, **synthetic prober** | **live on cluster** — K20 |
| `backbone_memory_rows{table}` | backbone-exporter ← `memory_store.db` | **live** — K23 |
| `backbone_workflow_runs_total{job}` | backbone-exporter ← `cron/jobs.json` | **live** — K21 |
| `backbone_workflow_last_run_timestamp_seconds{job}` | same | live |
| `backbone_cost_usd_total{status,source}` | backbone-exporter ← `state.db.sessions` | **live** — K22 |
| `backbone_tokens_total{kind}` | same | live |
| `backbone_model_cost_usd_total{model}` | same | live |
| `backbone_sessions_total` | same | live |

### The gap, and how it was closed

**hermes-agent has no `/metrics` endpoint** — verified, `grep -rniE 'prometheus|/metrics'` over
the upstream tree returns nothing. Every gateway signal would otherwise be inferred from outside
the application.

`services/backbone-exporter/` closes it by reading the state the agent already writes:
`state.db.sessions` for cost and tokens, `memory_store.db` for the substrate, `cron/jobs.json`
for the scheduler, `kanban.db` for task runs — plus a prober for the one quantity nothing
records. Stdlib Python, ~300 lines, no dependencies.

Two things it taught, both in [`OPERATIONS.md`](./OPERATIONS.md): `pathlib.exists()` *raises* on
an unreadable parent rather than returning False, and a `readOnly` volume mount breaks SQLite
WAL readers because opening even read-only requires creating the `-shm` file.

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

## 4. Langfuse — configured, deliberately not deployed

`tracing.enabled` injects `HERMES_LANGFUSE_*` into the gateway. Those are the **correct** names:
hermes-agent ships a bundled plugin at `plugins/observability/langfuse/` that reads the
`HERMES_`-prefixed variables. An earlier revision of this chart injected `LANGFUSE_HOST` and
`LANGFUSE_SAMPLE_RATE`, which that plugin ignores entirely — tracing would have silently done
nothing (VALIDATION L31).

**It is not deployed, and that is a decision rather than an omission.** Langfuse existed in the
plan to answer *cost per task*. `state.db.sessions` already answers it — per-session model,
token breakdown, and cost, across 1,111 sessions — so standing up Langfuse plus a second
Postgres would add ~700 MB and a service to maintain in exchange for a number the system
already records.

What Langfuse would still add is **per-span tracing** — which tool call in a turn was slow, what
the model actually saw. That is real value and a real gap; it is simply not the same question as
cost per task, and this repo no longer claims it. [`VALIDATION.md`](../VALIDATION.md) C15.

## 5. The dashboard

`observability/grafana-dashboard.json` — importable, **21 panels in 5 rows**, no dependencies
beyond Prometheus, kube-state-metrics and backbone-exporter.

| Row | Panels |
|---|---|
| **Availability** | gateway up/down · restarts (30 m) · notify-mcp replicas · uptime |
| **Notifications** | delivery by channel · all-channel failures · p50/p95 fan-out latency · tool errors |
| **Resources** | gateway memory vs. limit · state volume free |
| **Scheduled work** | CronJob last success age · failed jobs |
| **Agent — the three metrics the brief named** | recall latency p50/p95 · memory substrate size · workflow runs by job · workflow staleness · **cost per task** · cost by derivation · cost by model · token mix · exporter health |

Every panel has a query and every query has a source. There are no hidden panels.

## 6. Verification status

| Claim | Status |
|---|---|
| Recall latency, workflow success rate and cost per task are all live | **verified on the cluster** — K20, K21, K22 |
| notify-mcp exposes valid Prometheus exposition | **verified** — L14, and a unit test asserts every line matches the format |
| The metrics move when the tool is used | **verified** — L14 |
| The dashboard JSON is valid and every panel has a query | **verified** — L20 |
| PrometheusRule and ServiceMonitor render and validate | **verified** — L18 |
| Grafana renders the dashboard | **not done** — C7 |
| The numbers move when the system is used on a cluster | **not done** — C7, the Phase 5 gate |
| Langfuse receives a trace | **not done** — C15 |

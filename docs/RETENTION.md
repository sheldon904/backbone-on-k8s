# Retention policy

The brief asks for "the governance JSONL audit stream to a PVC, a CronJob that rotates and
prunes, and a written retention policy."

**The governance audit stream does not exist.** That has to be said before any policy, because
a retention policy for a stream that emits nothing is theatre.

---

## 1. What actually emits

From [`00-CURRENT-STATE.md §2`](./00-CURRENT-STATE.md): the governance gate was removed on
2026-05-24. `adapters/mcp-governance` is `@backbone/mcp-notify` and registers one tool. The
audit log, proposal store and policy engine are compiled, tested, and **imported by nothing at
runtime**.

What survives is frozen, not live:

```
~/.hermes/archive-backbone-2026-05-24/
  governance-audit.jsonl        14,388 bytes   (last write 2026-05-24)
  governance-policies.json       1,078 bytes
  governance-store/              2 proposal records
```

So the streams this policy governs are the ones that do emit:

| Stream | What it is | Sensitivity |
|---|---|---|
| `logs/agent.log` | Every tool call, MCP registration, model request, error | **High** — contains message content and tool arguments |
| `logs/hermes-voice.log`, `logs/ask-hermes.log` | Voice sidecar and Vapi handler | High — transcribed speech |
| `state.db` → `messages` | Full message history, FTS-indexed | **Highest** — this is the conversation archive |
| `memory_store.db` → `facts`, `entities`, `edges`, `decision_log` | Extracted long-term memory | **Highest** — derived personal data |
| `kanban.db` → `task_events`, `task_runs` | Task lifecycle | Medium |
| `verification_evidence.db` | Verification events | Medium |
| `backbone_notify_*` metrics | Counters, no content | Low |

## 2. Policy

**Operational logs are retained 90 days, then deleted. Conversation and memory state is
retained indefinitely, with dated backups kept 14 days.**

| Class | Retention | Mechanism | Then |
|---|---|---|---|
| Operational logs (`logs/*.log`) | **90 days** | `audit-rotate` CronJob, daily 04:17 | deleted |
| Rotated log segments | 90 days from rotation | same job, `find -mtime +90 -delete` | deleted |
| Message history (`state.db`) | **indefinite** | none — it is the product | — |
| Memory (`memory_store.db`) | **indefinite** | usage-driven forgetting inside the app, not here | — |
| Dated backups | **14 days** | `backup` CronJob, daily 07:00 | pruned |
| Metrics | 15 days | Prometheus default | dropped |
| Traces (Langfuse) | 30 days | Langfuse config | dropped |

### Why 90 days for logs

Long enough to investigate a problem noticed weeks late — the realistic detection window for a
system used daily by one person, where a subtle misbehaviour surfaces as "hasn't that been
wrong for a while?" rather than as an alert. Short enough that a log containing message content
is not accumulating indefinitely on a volume that also cannot be expanded online.

It is a judgement, not a derivation from a requirement. There is no compliance regime over this
data — it is one person's personal system. If this pattern were deployed for a customer, the
number would come from their regime and this section would cite it.

### Why message history is indefinite

Deleting it would delete the product. The agent's value is continuity; `state.db` and
`memory_store.db` *are* the second brain. A retention limit here is a feature request
("forget things older than X"), not a hygiene policy — and the hybrid memory plugin already
implements usage-driven forgetting at the application layer, which is the right place for it.

Rotation is bounded by size instead: the CronJob rotates any log over 64 MB so a single file
cannot fill the volume between daily runs.

## 3. Implementation

Both jobs are in `charts/backbone/templates/cronjobs.yaml`.

**`audit-rotate`** — daily at 04:17.
- Copy-then-truncate, **not** `mv`. The gateway holds an open file descriptor; `mv` would leave
  it writing to an unlinked inode that nothing can read and that never frees its blocks.
- Prunes rotated segments past the window.

**`backup`** — daily at 07:00.
- `sqlite3` online `.backup` API, **not** `cp`. The databases are WAL-mode with a live writer;
  `cp` copies the main file without the WAL and silently loses the most recent commits.
- Verified locally against the live 22 MB `memory_store.db`: `journal_mode` is `wal`, and
  `.backup` produced an `integrity_check ok` copy with all 25 tables and correct row counts in
  0.18 s while the gateway held it open. [`VALIDATION.md`](../VALIDATION.md) row L19.

### The honest limitation

**Backups are written to the same PVC as the data.** That is a copy, not a backup. It survives
accidental deletion and nothing else — not volume loss, not node loss, not a corrupted
filesystem. The same flaw exists today on the droplet, where 712 MB of backups sit on the same
disk as the data they protect.

Fixing it means shipping off-cluster, which means object storage credentials and egress. It is
tracked as S2 in [`02-STATE-TRADEOFFS.md`](./02-STATE-TRADEOFFS.md) and it is **not done**.

## 4. Access

| | |
|---|---|
| Who can read the audit stream | anyone with `kubectl exec` into the gateway pod, or the volume |
| Restricted by | RBAC on the namespace. **Not configured in this repo** — single-user cluster |
| Is it tamper-evident | **No.** The removed governance package implemented a hash-chained audit log with a `chain_valid` check. Nothing in the live path does. A plain log file can be edited by anything that can write the volume |

That last row is the real cost of the 2026-05-24 teardown. The tamper-evidence property was
built and tested — 57 passing tests in `packages/governance`, including hash-chain
verification — and then taken out of the request path. Reinstating it would mean routing tool
calls back through the gate, which is a product decision about the whole system, not a
Kubernetes one.

## 5. What would have to change to make the governance stream real

Listed because "the audit stream does not emit" should come with the path to fixing it:

1. Re-wire `packages/governance`'s gate in front of world-affecting tool calls — which means
   either an MCP proxy that all tool traffic passes through, or upstream support in hermes-agent
   for a policy hook.
2. Point the audit log at a path on the state PVC.
3. Add that path to `audit.streams` in `values.yaml` — the CronJob then rotates it with no
   further change.

Step 1 is the whole job; steps 2 and 3 are already supported. That asymmetry is worth naming:
the *infrastructure* for governed audit is in place here, and the *governance* is not.

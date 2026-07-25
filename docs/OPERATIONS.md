# Operations log

Append-only. Every incident, restart, OOM, failed probe, PVC issue, cert expiry, upgrade.
Newest at the bottom. Format: date · symptom · what I thought · what it actually was · fix.

This file is the point of the project. It is not a placeholder and it does not get
back-filled — entries are written when the thing happens, including the wrong hypothesis.

**Scope note.** Entries so far are from *building* the artifacts, not from operating a live
cluster. Cluster operations entries begin at Phase 6, which has not started. Nothing below
should be read as evidence that the system has run on Kubernetes.

---

## 2026-07-25 — `tools/list` returns HTTP 500 against the stateless MCP transport

**Symptom.** After porting the notify MCP from stdio to Streamable HTTP, `initialize`
succeeded and returned a correct `serverInfo`:

```
$ curl -sS -X POST localhost:18080/mcp -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},
       "serverInfo":{"name":"backbone","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

but the very next call returned an empty body, and after sending
`notifications/initialized` it returned **HTTP 500** with nothing on stdout from the process.

**What I thought.** That the server was rejecting the request because the MCP handshake was
incomplete — that `initialize` had to be followed by `notifications/initialized` on the same
connection before `tools/list` would be accepted. So I sent the notification. That made it
worse: 500 instead of an empty 200.

**What it actually was.** A design error, not a handshake error. I had constructed **one**
`Server` and **one** `StreamableHTTPServerTransport` at boot and reused them for every request:

```ts
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await mcpServer.connect(transport);           // once, at startup
// ...then, per request:
transport.handleRequest(req, res);
```

That works for stdio, where there is exactly one client for the process's lifetime. It does
not work for stateless HTTP. With `sessionIdGenerator: undefined` the transport keeps no
session, so each POST is an independent connection — but the single shared transport instance
still carries per-connection state (the response stream it last bound to, in-flight request
IDs). The second request lands on a transport whose stream is already closed.

**Fix.** Instantiate a fresh `Server` + `StreamableHTTPServerTransport` per request and close
both when the response finishes. This is the pattern stateless mode is designed for, and it is
also the correct answer for Kubernetes: no cross-request state means no session affinity, which
means the Deployment can scale past one replica without sticky sessions on the Ingress.

```ts
const server = createMcpServer(tools);
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
res.on('close', () => { void transport.close(); void server.close(); });
await server.connect(transport);
await transport.handleRequest(req, res);
```

**Verified.** `tools/list` now returns the `notify` tool, and `tools/call` returns a
structured result. Commands and output in [`VALIDATION.md`](../VALIDATION.md) rows L10–L12.

**What this cost.** Roughly twenty minutes, and it would have cost far more on a live cluster:
the failure mode is that the *first* request after a pod starts succeeds and every subsequent
one fails. A readiness probe hitting `/healthz` would have reported the pod healthy the whole
time. This is the argument for a readiness probe that exercises the actual protocol path, not
just process liveness — noted as an open item in
[`01-CONTAINERIZATION.md`](./01-CONTAINERIZATION.md).

## 2026-07-25 — NUL byte written into a source file

**Symptom.** An exact-match string edit against `src/server.ts` failed repeatedly with "string
to replace not found", while the file plainly contained the string when read back.

**What I thought.** Whitespace or a smart-quote substitution.

**What it actually was.** A literal `\x00` had been written where a space character belonged,
inside a string literal:

```
164 "if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() || '\x00')) {"
```

TypeScript compiled it without complaint — a NUL is a valid character in a string literal — so
this would have shipped silently. The guard it lived in decides whether the module starts a
listener when imported, so the failure mode would have been a test run mysteriously binding a
port, or the container starting nothing at all.

**Fix.** Replaced the line by index rather than by content match, and added a repo-wide scan:

```
$ grep -rlP '\x00' --include='*.ts' --include='*.json' --include='*.md' .
(no output)
```

**Kept as a lesson.** "The edit tool can't find a string that is visibly there" means the bytes
differ from what is rendered. Check `repr()`, don't re-read.

## 2026-07-25 — healthcheck reported a container healthy that was never started

**Symptom.** `scripts/healthcheck.sh` was run against a stack where only `notify-mcp` was
running. It correctly failed on ntfy, and then reported:

```
  ok    hermes-gateway webhook port accepting connections
```

The gateway image has never been built. There was no gateway container. Nothing should have
answered.

**What I thought.** A bug in the conditional — that `curl -sS -o /dev/null` was returning 0
even on a failed connection, the way it does on an HTTP 404 without `-f`.

**What it actually was.** Worse, and more interesting. Something *did* answer. The check
defaults to `http://127.0.0.1:8645`, and the Phase 0 audit recorded the **live production
gateway** bound to `0.0.0.0:8645` on this same host. The healthcheck for the containerized
stack had reached across and probed the running system it is meant to replace, and reported
that as the container being healthy.

This is the most dangerous class of false positive: a check that is green for the wrong
reason. On a cutover day it would report the new stack up while the old one was serving every
request.

**Fix, two parts.**

1. Compose host-port bindings moved off the live droplet's ports entirely
   (`18080`, `18081`, `18645` instead of `8080`, `8081`, `8645`). This is not just collision
   avoidance — during Phase 6 cutover both stacks have to run side by side on purpose, so
   they must never contend for a port.
2. The gateway check no longer treats "something accepted a TCP connection" as a pass. It
   requires a response the containerized gateway can be distinguished by, and reports
   `skip` rather than `ok` when it cannot tell.

**Kept as a lesson.** A liveness check that only proves *a* process is listening proves
nothing about *which* process. Every port-based check in this repo now either asserts on
response content or degrades to `skip`. Same failure shape as the transport bug two entries
up: a green check that was not testing what it claimed to test.

## 2026-07-25 — the gateway image build failed, and the reason corrected the Phase 0 audit

**Symptom.** First CI run. Three jobs green; the `hermes-gateway` image build failed
(`continue-on-error`, so it reported rather than blocked):

```
#10 0.635 warning: Could not find remote branch v0.18.0 to clone.
#10 0.635 fatal: Remote branch v0.18.0 not found in upstream origin
ERROR: failed to solve: process "git clone --depth 1 --branch v0.18.0 ..." exit code: 128
```

**What I thought.** A private repository, or a rate limit on an unauthenticated clone.

**What it actually was.** Three separate things, in increasing order of importance.

**1. The version string is not a git ref.** `hermes --version` prints:

```
Hermes Agent v0.18.0 (2026.7.1) · upstream 07e97d2f
```

I read `v0.18.0` as the tag. It is the internal product version. Upstream tags are date-based:

```
$ git ls-remote --tags https://github.com/NousResearch/hermes-agent.git | tail
... refs/tags/v2026.6.5
... refs/tags/v2026.7.1      <- this one
... refs/tags/v2026.7.7
... refs/tags/v2026.7.20
```

The parenthesised `(2026.7.1)` was the tag all along. Fixed: `HERMES_REF=v2026.7.1`.

**2. The running checkout is 3644 commits behind upstream `main`.**

```
$ git -C ~/.hermes/hermes-agent status -sb
## main...origin/main [behind 3644]
 M cron/scheduler.py
```

Pinning a tag is still right — but "pinned to the version that is running" and "pinned to
something recent" are very different claims, and only the first is true.

**3. The running checkout is patched. My Phase 0 audit missed this.**

That ` M cron/scheduler.py` is an uncommitted local modification to upstream:

```python
-            skip_memory=True,  # Cron system prompts would corrupt user representations
+            skip_memory=not bool((_cfg.get("cron") or {}).get("memory_enabled", False)),
```

Upstream hardcodes `skip_memory=True` for cron jobs. The live system deliberately makes it
opt-in so cron agents can read and write persistent memory, and `config.yaml` sets
`cron.memory_enabled: true`. The patch's own comment records that a hermes update reverts the
file and it has to be reapplied.

**This is the significant one.** An image built from a pinned upstream ref does **not**
reproduce the running system. It silently loses the patch, and the symptom would be the 8 cron
jobs running with no memory access — not a crash, not a failed probe, just subtly degraded
agents. It would have been found weeks later, during Phase 6, as "why has cron been dumb since
the migration".

**What I got wrong in the audit.** [`00-CURRENT-STATE.md`](./00-CURRENT-STATE.md) recorded the
upstream repo and version and treated the checkout as pristine. I ran `git log --oneline -3`
and never ran `git status`. One command, and it was the one that mattered.

**Fix.**
- `HERMES_REF` corrected to `v2026.7.1`.
- The Dockerfile now applies `patches/*.patch` after cloning, and **fails the build if a patch
  does not apply** — because a silently skipped patch is exactly the failure mode above.
- `00-CURRENT-STATE.md` gains a §12 recording the drift and the patch.
- [`VALIDATION.md`](../VALIDATION.md) C13 stays unverified until a build is green.

**Kept as a lesson.** "Pin the version you observed" is only as good as the observation. A
version string printed by an application is a claim about itself, not a fact about its source
tree. `git status` on a vendored checkout is not optional.

## 2026-07-25 — gateway image builds green

Follow-up to the entry above. With `HERMES_REF=v2026.7.1` and the patch regenerated from the
real diff rather than hand-written, the build succeeds:

```
#13 0.048 applying 0001-cron-memory-opt-in.patch
#13 0.050 Checking patch cron/scheduler.py...
...
size: 365353842 bytes, user: 10001:10001
```

The tag is confirmed by upstream's own commit message: `chore: release v0.18.0 (2026.7.1)`.

**One thing in between was worth noting.** The first patch file was hand-authored and `git apply`
rejected it — `corrupt patch at line 35`, from writing unified-diff hunk headers by hand around
a prose preamble. That rejection is the Dockerfile working as designed: no `--3way`, so a patch
that does not apply cleanly fails the build instead of being skipped. Had it been lenient, the
image would have built *without* the patch and looked entirely healthy.

[`VALIDATION.md`](../VALIDATION.md) C13 moves to section 2 as CI8. 365 MB is larger than it needs
to be — the venv carries every optional dependency group named in `HERMES_EXTRAS`, and trimming
it is worth a pass once there is a cluster to test against.

## 2026-07-25 — a hardening test hung, and the hang was in the production path

**Symptom.** After adding the audit emitter to notify-mcp, `node --test dist/audit.test.js`
never returned. Not slow — *never*. Two runs sat at 10 minutes. The process was `State: S`
(sleeping), single-threaded, and had burned **6.5 s user / 15 s sys** in 30 s of wall clock, so
it was churning syscalls rather than blocking on I/O.

**What I thought.** Resource starvation. This box is 1 vCPU with 621 MB of swap in use, load was
2.8, and I had accidentally left two test runs competing. I killed the duplicates and re-ran.
Still hung. Then I suspected the OOM killer, because this droplet has a documented history of
OOM freezes.

Both wrong. `dmesg` showed no OOM kills, `/proc/pressure/memory` was flat zero, and
`node -e 'console.log(1)'` returned in **73 ms**. The environment was fine.

**What it actually was.** Piping to `tail` had been hiding the output — `tail` only flushes at
EOF, and the process never reached EOF. Redirecting to a file instead showed exactly where it
stopped:

```
ok   append+verify (2ms)
ok   50 lines (3ms)
--- now the suspicious one ---
                              <- nothing further, ever
```

The suspicious one was a test asserting that an unwritable audit path degrades gracefully. It
pointed at `/proc/definitely-not-writable/audit.jsonl`, and the hang is in:

```ts
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
```

**`mkdirSync(recursive: true)` does not fail fast on procfs.** Against a nonexistent path under
`/proc` it spins instead of throwing EACCES. The `try/catch` around it was useless — you cannot
catch a call that never returns.

**Why this mattered far more than a broken test.** That line was in `AuditLog.init()`, the
production path. Any deployment where `BACKBONE_AUDIT_DIR` pointed somewhere the container could
not write — a misconfigured `volumeMounts`, a `readOnlyRootFilesystem` with the audit volume
missing, a typo'd subPath — would have **hung the first tool call that tried to audit**, and
every one after it. The pod would pass `/healthz` throughout, because the HTTP server was fine.
It is the same failure shape as the two earlier entries in this log: green checks, dead system.

**Fix.** Probe before creating, and latch the failure:

```ts
let ancestor = dir;
while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
accessSync(ancestor, constants.W_OK);      // throws fast, catchable
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
accessSync(dir, constants.W_OK);
```

On failure, `disabled = true` latches so a bad path is not re-probed on every tool call, and
auditing degrades to a structured stderr line. The tool call still succeeds — an audit failure
must never take down the action it is auditing.

**Verified.** 13/13 pass in **200 ms**. Two regression tests now guard it: one against a
`chmod 0500` directory on a normal filesystem, one specifically against procfs, both asserting
completion in under 2 s rather than merely asserting the return value.

**Kept as a lesson.** Three separate times in this project a check has been green for the wrong
reason. This one inverts it: a *test* was red for the right reason, and I nearly dismissed it as
an environment problem because the box is small and genuinely was loaded. The tell was `sys`
time — a starved process waits, it does not burn 15 seconds of kernel time. And: never pipe a
possibly-hanging command through `tail`.

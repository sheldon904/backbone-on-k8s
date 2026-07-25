# 01 — Containerization

How each service becomes an image, what the systemd hardening maps to, and what does not
survive the move.

---

## 1. The stdio problem

This is the first real decision and it is forced by a detail in
[`00-CURRENT-STATE.md §3`](./00-CURRENT-STATE.md): **MCP servers are not services on this host.
They are child processes.** The gateway forks `node dist/server.js` and speaks JSON-RPC over
the child's inherited stdin/stdout. Three copies are resident because three Hermes host
processes each forked their own.

A sidecar container **cannot** receive that. Sidecars share a network namespace and optionally
a volume; they do not share a process namespace by default, and even with
`shareProcessNamespace: true` a parent in container A cannot `fork()` a binary that lives in
container B's filesystem. There is no arrangement of sidecars that preserves stdio MCP.

So there are exactly two options:

| | Option A — bake it in | Option B — network transport |
|---|---|---|
| What it means | Node + the MCP bundle ship inside the gateway image; the gateway keeps forking it | The MCP server becomes its own Deployment and Service, speaking Streamable HTTP |
| Image | Python **and** Node in one image; ~250 MB larger | Two small single-runtime images |
| Blast radius | A crash-looping MCP server is inside the gateway's container | Isolated; the gateway degrades to "tool unavailable" |
| Scaling | Tied 1:1 to the gateway, which is a singleton | Independent; stateless, scales horizontally |
| NetworkPolicy | Invisible — it is one process, so no policy can see the call | The call is a real network hop, so it can be allowed/denied explicitly |
| Observability | stderr interleaved into the gateway's logs | Its own logs, its own `/metrics`, its own probe status |
| Cost | none | a port of the transport, plus one more hop of latency |

**Chosen: Option B**, implemented in [`services/notify-mcp/`](../services/notify-mcp/).

The NetworkPolicy row is the one that decides it. Phase 4 requires default-deny between pods
with explicit allow rules. If the MCP server is a forked child, the gateway→MCP call is a
function call inside one process and no network policy can ever express it. Option B turns an
invisible trust relationship into one that is declared in YAML and enforced by the CNI. That is
the entire point of the exercise.

**RESOLVED 2026-07-25 — upstream supports it natively, no shim needed.** `tools/mcp_tool.py`
documents both transports and accepts `url`, `transport`, `headers` and `type` alongside the
stdio `command`/`args`/`env`:

```
tools/mcp_tool.py:55:  - Stdio transport (command + args) and HTTP/StreamableHTTP transport (url)
tools/mcp_tool.py:56:  - SSE transport (transport: sse) for MCP servers using the SSE protocol
tools/mcp_tool.py:205: from mcp.client.streamable_http import streamablehttp_client
```

So the `mcp_servers.backbone` entry becomes a `url:` pointing at the Service, and the whole
stdio→HTTP decision costs nothing beyond the port itself. [`VALIDATION.md`](../VALIDATION.md)
row C10 moves to verified locally as L30.

## 2. What changed and why

Beyond the transport, three changes were needed to make the notify service containerizable.

**curl → fetch.** The original calls `execFile('curl', ...)` for both channels. That requires a
base image with a shell and curl. Node 20+ has `fetch` built in, so the subprocess is
unnecessary — and removing it is what makes a distroless base possible. This was not a
mechanical substitution: `execFile` rejects when `curl -f` turns an HTTP 4xx into a non-zero
exit, while `fetch` resolves on 4xx and rejects only on transport failure. Without an explicit
`res.ok` check, a rate-limited Telegram send reports as delivered. There is a test for exactly
that.

**Serial → concurrent fan-out.** The original awaits Telegram, then ntfy. A 15 s Telegram
timeout therefore delayed ntfy by the full 15 s. Under systemd that is slow; under a readiness
probe with a 5 s timeout it is a restart. Now `Promise.all`.

**Readiness is not liveness.** `/healthz` answers "is the process up". `/readyz` answers "would
a request succeed" — with neither channel configured, it returns 503, because the alternative
is a pod that passes every probe while silently failing every notification.

## 3. systemd → container securityContext

The Backbone repo contains a well-hardened `deploy/hermes.service`. **It is not the unit
installed on the host** (see [`00-CURRENT-STATE.md §4`](./00-CURRENT-STATE.md)) — the running
`hermes-gateway.service` has none of it. So this table is not "preserving" a posture; it is
applying, in the new substrate, the posture the repo always intended. Both columns are
therefore aspirational-made-real, and that is stated rather than glossed.

| systemd directive | Kubernetes equivalent | Carried over? |
|---|---|---|
| `User=backbone` / `Group=backbone` | `runAsUser: 10001`, `runAsGroup: 10001`, `runAsNonRoot: true` | **yes** |
| `NoNewPrivileges=true` | `allowPrivilegeEscalation: false` | **yes** — exact equivalent |
| `ProtectSystem=strict` | `readOnlyRootFilesystem: true` | **yes**, and stricter: systemd's `strict` still leaves `/dev`, `/proc`, `/sys` writable in places |
| `ProtectHome=read-only` | n/a — there is no `/home` in the image | **superseded** |
| `PrivateTmp=true` | `emptyDir` mounted at `/tmp` | **yes** |
| `ReadWritePaths=…` | explicit `volumeMounts` only | **yes**, and narrower — the container has no other writable path at all |
| `ProtectKernelTunables/Modules/Logs` | `capabilities.drop: [ALL]` + no `/proc` or `/sys` mounts | **yes**, by construction |
| `ProtectControlGroups=true` | container cgroup namespace | **yes**, by construction |
| `ProtectClock=true` | `CAP_SYS_TIME` dropped with ALL | **yes** |
| `ProtectHostname=true` | UTS namespace | **yes**, by construction |
| `ProtectProc=invisible` | PID namespace (default, no `hostPID`) | **yes**, by construction |
| `RestrictNamespaces=true` | `CAP_SYS_ADMIN` dropped | **yes** |
| `RestrictRealtime=true` | `CAP_SYS_NICE` dropped | **yes** |
| `RestrictSUIDSGID=true` | `CAP_SETUID`/`CAP_SETGID` dropped + `allowPrivilegeEscalation: false` | **yes** |
| `LockPersonality=true` | `seccompProfile: RuntimeDefault` blocks `personality()` | **yes** |
| `SystemCallFilter=@system-service` | `seccompProfile: RuntimeDefault` | **partial** — see below |
| `SystemCallFilter=~@privileged @resources` | `capabilities.drop: [ALL]` | **partial** — see below |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | **no direct equivalent** | **not carried** — see below |
| `MemoryMax=1G` / `MemoryHigh=768M` | `resources.limits.memory` / `requests.memory` | **yes** — `limits` is the OOM-kill line, `requests` is the scheduling floor. `MemoryHigh`'s *throttle-before-kill* behaviour has no direct analogue |
| `TasksMax=256` | `resources.limits.pids` **only if the runtime supports it** | **partial** — not settable per-container in stock Kubernetes; a kubelet-level `podPidsLimit` is the closest lever, and it is node-wide |
| `LimitNOFILE=4096` | container runtime default (usually 1048576) | **not carried** — would need an init container calling `ulimit`, judged not worth it |
| `StartLimitIntervalSec=300` / `StartLimitBurst=5` | `CrashLoopBackOff` (exponential, 10s→5min, uncapped in count) | **different, not equivalent** — see below |
| `Restart=always` / `RestartSec=10` | `restartPolicy: Always` | **yes** |
| `TimeoutStopSec=240` | `terminationGracePeriodSeconds: 240` | **yes** |

### Three things that genuinely do not carry over

**1. `RestrictAddressFamilies`.** systemd can forbid a process from creating, say, an
`AF_NETLINK` or `AF_PACKET` socket. There is no pod-level equivalent — `securityContext` has no
address-family control, and seccomp `RuntimeDefault` does not filter `socket()` by family. The
closest control is at a different layer entirely: NetworkPolicy governs *where* traffic may go,
not *what kind of socket* may be opened. A custom seccomp profile could restore it; the
tradeoff is maintaining a bespoke profile per service and debugging syscall denials with no
good error message. **Decision: accept the gap, close it with NetworkPolicy egress rules in
Phase 4.** Documented rather than silently dropped.

**2. `SystemCallFilter` is coarser.** `@system-service` is a curated allowlist of roughly 300
syscalls. `RuntimeDefault` seccomp blocks about 44 dangerous ones and allows the rest — a
denylist, not an allowlist. That is a genuine reduction in strictness. Restoring parity means a
custom `localhostProfile` seccomp JSON per service, mounted on every node. **Decision: use
`RuntimeDefault` now, note the gap.** For a personal cluster the maintenance cost of bespoke
seccomp profiles exceeds the marginal risk reduction; in a customer environment with a
compliance driver, the answer would be different, and that difference is the interesting part.

**3. Restart burst caps are not the same shape.** systemd's `StartLimitBurst=5` /
`StartLimitIntervalSec=300` means *give up permanently* after 5 restarts in 5 minutes — the
unit enters `failed` and stops trying. Kubernetes `CrashLoopBackOff` backs off exponentially to
a 5-minute ceiling and then **retries forever**. There is no "give up" state. The practical
difference: a persistently broken gateway on systemd goes quiet and waits for a human;
on Kubernetes it retries every 5 minutes indefinitely. For a service whose crash might be
caused by a paid API call, that is a real cost difference. Mitigation is alerting on
`kube_pod_container_status_restarts_total`, in Phase 5 — not a platform feature.

Worth noting: the **installed** unit has `StartLimitIntervalSec=0`, meaning no cap at all and
restart-forever at 5-second intervals. Against that baseline, `CrashLoopBackOff`'s exponential
backoff is a strict improvement.

## 4. Base images

| Service | Base | Why |
|---|---|---|
| `notify-mcp` | `gcr.io/distroless/nodejs22-debian12:nonroot` | No shell, no package manager, no curl. Possible only because the curl dependency was removed |
| `hermes-gateway` | `python:3.11-slim` | Distroless is not viable — see below |
| `ask-hermes` | `python:3.11-slim` | Same runtime as the gateway, no compiled deps |

### Why the gateway cannot be distroless

The gateway is not a self-contained application. From the audit:

- It **spawns subprocesses as a core feature** — the `terminal` toolset runs shell commands, and
  MCP servers are forked. A distroless image has no `/bin/sh`; the terminal toolset would fail
  at runtime, not at build time.
- Its `terminal.backend` is `local` with `docker_image: nikolaik/python-nodejs:...` configured
  as an alternative. Running the terminal toolset in-container on Kubernetes needs a decision
  of its own; **it is not resolved in this phase** and is tracked as an open question below.
- It reads and writes 9 GB of state across five SQLite files, needing a real filesystem layout.

`python:3.11-slim` is the honest choice. It is ~150 MB versus ~50 MB distroless, and it has a
shell — which is precisely why the securityContext (`readOnlyRootFilesystem`,
`allowPrivilegeEscalation: false`, `drop: [ALL]`) and the NetworkPolicy matter more for this
pod than for the others.

## 5. The gateway image is not built from source in this repo

`services/hermes-gateway/Dockerfile` installs `hermes-agent` from its upstream Git repository at
a **pinned tag**. This repo does not vendor or fork upstream — but it does apply **one patch**,
and that turned out to be non-negotiable.

Not vendoring is deliberate: it would make this repo responsible for tracking an actively
developed upstream. Pinning a tag gives reproducible builds without that ownership.

**The patch is not optional, and finding that out cost a CI run.** The Phase 0 audit recorded
the upstream repo and version and treated the checkout as pristine. It is not — `git status` on
the running checkout shows an uncommitted modification to `cron/scheduler.py` that makes
`skip_memory` opt-in for cron jobs instead of hardcoded true. Without it, all 8 cron jobs run
with **no memory access**, and that failure is silent: no crash, no failed probe, just worse
agents. It is vendored as `patches/0001-cron-memory-opt-in.patch` and applied with `git apply`
*without* `--3way`, so a patch that stops applying **fails the build** rather than being skipped.

Two further corrections from the same investigation:

- The tag is **`v2026.7.1`**, not `v0.18.0`. `hermes --version` prints
  `Hermes Agent v0.18.0 (2026.7.1)`; the first is an internal product version and the
  parenthesised part is the upstream tag. Upstream tags are date-based.
- The running checkout is **3644 commits behind** upstream `main`. Pinning is still correct, but
  "pinned to what is running" and "pinned to something recent" are different claims.

Full write-up in [`OPERATIONS.md`](./OPERATIONS.md), 2026-07-25.

**Consequence, stated plainly:** the gateway image build is **unverified**. Whether
`pip install` of that commit succeeds in a clean container, which optional dependency groups
are actually required, and whether the entrypoint works without `~/.hermes` pre-populated are
all open. CI attempts the build; until that is green, [`VALIDATION.md`](../VALIDATION.md) row
C13 stays in section 3.

## 6. Open questions from this phase

| # | Question | Why it is not answered here |
|---|---|---|
| Q1 | Does hermes-agent v0.18.0 support an HTTP MCP transport in `mcp_servers`, or is a stdio→HTTP shim needed? | Needs a config experiment against the live gateway; explicitly out of scope for this work |
| Q2 | What happens to the `terminal` toolset in a container? | It shells out by design. On Kubernetes the choices are: disable it, keep it in-container behind the securityContext, or give it a job-per-invocation sandbox. Decided in Phase 4, not here |
| Q3 | Can `readOnlyRootFilesystem: true` hold for the gateway? | It writes to `~/.hermes` (mounted PVC) and `~/.cache`. Whether anything writes outside those is only discoverable by running it |
| Q4 | Should `/readyz` on the gateway exercise the MCP path rather than just liveness? | The 2026-07-25 incident argues yes. Needs a cheap protocol-level check that does not send a notification |

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

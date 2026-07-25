# Why not Compose

**Still mostly unwritten — but no longer empty.** The first entry below was earned on
2026-07-25 by actually running the Compose stack on a VPS, and it is a real answer to the
question this document exists to ask.

The brief says to write it *after* Phase 6, from experience — specifically: "where systemd and
Compose actually stopped being enough for me, with specifics."

Phase 6 has not happened, and the seven-day operating window has not been run. So the bulk of
this document stays unwritten: filling it in now would mean inventing the answer to the most
interesting question in the project, and the invented answer is the generic one anybody can
produce from a blog post — declarative reconciliation, self-healing, rolling updates, resource
isolation. True, unearned, and worth nothing in an interview.

**The rule for this file: an entry appears only after the thing actually happened to me.** One
has. The rest wait.

---

## Earned entries

### 1. Volume ownership — Kubernetes does declaratively what Compose makes imperative

**2026-07-25, first Compose bring-up on a fresh VPS.** The gateway CrashLooped immediately:

```
PermissionError: [Errno 13] Permission denied: '/home/hermes/.hermes/logs'
```

Docker creates named volumes **root-owned**. The gateway runs as uid 10001 (because the image
is hardened, per `docs/01-CONTAINERIZATION.md` §3) and therefore cannot create a directory
inside its own state volume.

```
$ docker run --rm -v backbone_hermes-state:/v alpine sh -c 'ls -ldn /v'
drwxr-xr-x 2 0 0 4096 /v          <- root:root
```

**Kubernetes solves this in two declarative lines**, which the chart already had before this was
ever observed:

```yaml
securityContext:
  fsGroup: 10001
  fsGroupChangePolicy: OnRootMismatch
```

The kubelet chowns the volume to the fsGroup on mount. Nothing else is required and nothing can
forget to do it.

**Compose has no equivalent.** There is no `fsGroup`, no ownership field, nothing declarative.
The fix is an imperative extra service that exists purely to run `chown` before the real
workload starts:

```yaml
volume-init:
  image: alpine:3.20
  user: "0"
  command: ["sh","-c","chown -R 10001:10001 /state"]
  volumes: [hermes-state:/state]
  restart: "no"
```

plus a `depends_on: { volume-init: { condition: service_completed_successfully } }` on the
gateway — which must be map form, not list form, and silently fails to parse if mixed.

**Why this is the real answer and not a nitpick.** Three separate things had to be got right in
Compose (a privileged helper container, correct dependency *condition* syntax, and remembering
it at all) to achieve what one field does in Kubernetes. And the failure mode is a container
that starts, prints a banner, and dies — on first run, on a clean machine, for a stack that had
passed every static check in CI.

It is a small example of the general shape: **Compose expresses what to run; Kubernetes
expresses what must be true.** Ownership is a property of the volume, not a step in a script,
and only one of the two lets you say that.

## What this document will need to answer

Recorded now so the eventual version is written against questions asked before the outcome was
known, rather than reverse-engineered from whatever happened.

1. **Did anything actually break under systemd that Kubernetes fixed?** The honest possibility
   is *no*. The droplet has run for 62 days with `NRestarts=0` on the gateway. If nothing broke,
   the answer has to be about something other than reliability, and pretending otherwise would
   be dishonest.

2. **Was the singleton constraint worth the complexity?** The gateway is `replicas: 1` with
   `Recreate`, permanently. Kubernetes' headline capability — horizontal scaling — is
   unavailable for the primary workload by construction. What is left is scheduling, secret
   management, and policy. Is that worth a control plane?

3. **What did the stdio→HTTP port actually cost?** It bought a NetworkPolicy-visible hop. It
   cost a network round trip per tool call, a second image, and — if hermes-agent turns out not
   to support HTTP MCP transports — a shim. After operating it, was the isolation worth the
   latency and the moving part?

4. **Did default-deny egress catch anything, or just cause outages?** The prediction is that it
   causes at least one confusing outage (DNS, or an API whose IP range moved) before it ever
   prevents anything. Both halves belong in the record.

5. **Where did 2 GiB stop being enough?** The target cluster has to be bigger than the source
   droplet. By how much, and what forced it — Keycloak, Prometheus, or the control plane?

6. **Did `readOnlyRootFilesystem: true` survive contact with the gateway?**
   [`VALIDATION.md`](../VALIDATION.md) row C11 says this is unverified. The answer is a fact
   about upstream software, discoverable only by running it.

7. **What did the seven days actually look like?** Restarts, OOM kills, failed probes, cert
   renewals, a PVC filling up. If [`OPERATIONS.md`](./OPERATIONS.md) has no entries after a
   week, that is itself the finding — and it argues *against* the migration, which is a
   conclusion this project has to be willing to reach.

## What exists instead, right now

Three entries in [`OPERATIONS.md`](./OPERATIONS.md), all from *building* the artifacts rather
than operating them:

- a stateless HTTP transport that answered the first request and failed every one after, while
  `/healthz` stayed green
- a NUL byte written into a source file, which compiled without complaint
- a healthcheck that reported the **live production gateway** as a healthy container, because
  the default port collided with the system it is meant to replace

They share a shape: **a green check that was not testing what it claimed to test.** That is a
real theme and it is already worth something. It is not the same as knowing where Compose stops
being enough.

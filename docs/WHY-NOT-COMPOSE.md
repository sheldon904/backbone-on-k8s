# Why not Compose

**This document is deliberately unwritten.**

The brief says to write it *after* Phase 6, from experience — specifically: "where systemd and
Compose actually stopped being enough for me, with specifics."

Phase 6 has not happened. Nothing in this repository has run on a Kubernetes cluster. Writing
this document now would mean inventing the answer to the most interesting question in the
project, and the answer would be the generic one anybody can produce from a blog post:
declarative reconciliation, self-healing, rolling updates, resource isolation. That list is
true, unearned, and worth nothing in an interview.

So it stays empty until it is real.

---

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

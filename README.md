# backbone-on-k8s

Kubernetes deployment of **Backbone** — my personal always-on agent system: a Hermes Agent
gateway, an MCP tool server, and a notification bridge, currently running as systemd units on a
DigitalOcean droplet.

**Status: running on a live k3s cluster since 2026-07-25.** Migrated from systemd, via Compose,
onto k3s + Cilium with sealed-secrets, Keycloak SSO, enforced default-deny NetworkPolicy, a
hash-chained audit stream, and metrics for a system that exposes none. Every claim below traces
to a command in [`VALIDATION.md`](./VALIDATION.md) or raw output in
[`evidence/`](./evidence/).

That sentence is the whole README in miniature, and the rest of this file does not walk it
back. [`VALIDATION.md`](./VALIDATION.md) is the authoritative record of what has been observed
versus what has only been written.

---

## How this differs from `agent-fleet-on-eks`

I have two Kubernetes repositories and they are not the same exercise.

| | [`agent-fleet-on-eks`](https://github.com/sheldon904/agent-fleet-on-eks) | **`backbone-on-k8s`** (this repo) |
|---|---|---|
| **What it is** | An enterprise *reference deployment* — what I would stand up in a customer's AWS account | *My own system*, migrated onto cheap self-managed k3s |
| **Substrate** | AWS EKS, Terraform, managed node groups | k3s on one VM |
| **Secrets** | AWS Secrets Manager via the Secrets Store CSI driver, IRSA-bound | **sealed-secrets** — there is no cloud secret store, and no IAM identity to bind to |
| **Identity** | Cognito | **Keycloak** — there is no cloud IdP |
| **Workloads** | Purpose-built reference services | Real software I did not write (hermes-agent v0.18.0) with real state and real constraints |
| **Lifecycle** | Stood up and torn down per session | Meant to run continuously |
| **The deliverable** | The runbook | The **operational experience** — [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) |

The substrate difference forces different correct answers, and that is the point of having
both. Sealed-secrets is not a downgrade from Secrets Manager; it is the right answer when there
is no cloud secret store and the private key must never leave the cluster. Keycloak is not a
poor-man's Cognito; it is what you use when there is no cloud identity provider to federate
with.

**This repo does not reuse `agent-fleet-on-eks`'s SOC 2 mapping or its runbook.** Different
substrate, different controls, and a control mapping copied across substrates is worse than
none.

## What is actually here

```
backbone-on-k8s/
├── docs/
│   ├── 00-CURRENT-STATE.md      the real inventory of the live droplet
│   ├── 01-CONTAINERIZATION.md   stdio-vs-network, and systemd -> securityContext
│   ├── 02-STATE-TRADEOFFS.md    why the datastore choice was not a choice
│   ├── 04-SECRETS.md            sealed-secrets, and losing the controller key
│   ├── 04-SSO.md                Keycloak + oauth2-proxy, with the sequence diagram
│   ├── 05-OBSERVABILITY.md      what can be measured, and what cannot
│   ├── RETENTION.md             retention policy for the streams that actually emit
│   ├── OPERATIONS.md            append-only incident log
│   └── WHY-NOT-COMPOSE.md       deliberately unwritten — see below
├── services/
│   ├── notify-mcp/              the MCP server, ported stdio -> Streamable HTTP
│   └── hermes-gateway/          Dockerfile for the upstream agent runtime
├── manifests/                   hand-written Kubernetes objects — these came FIRST
├── charts/backbone/             the values-driven chart, translated from manifests/
├── compose/                     the Phase 1 intermediate artifact
├── observability/               Grafana dashboard
├── runbook/                     prerequisites · install · failure modes · rollback
├── evidence/                    dated kubectl/helm/cilium output from live runs
└── scripts/                     validate.sh, parity-check.sh, healthcheck.sh
```

`manifests/` came before `charts/` on purpose — the brief was to learn the primitives before the
templating, and the plain objects are kept as the teaching artifact rather than deleted once the
chart worked. [`scripts/parity-check.sh`](./scripts/parity-check.sh) asserts the 21 properties
where the two must still agree.

## Three findings that changed the design

The build started with a Phase 0 audit rather than a migration plan, and the audit contradicted
the plan on three points.

**1. There is no container runtime on the host.** No Docker, no Postgres, no Redis. The brief
anticipated containerized supporting services to lift and shift. There is nothing to lift;
Phase 1 is a genuine first containerization.

**2. The governance gate is not in the request path.** `adapters/mcp-governance` is a misnomer —
the package is `@backbone/mcp-notify` and registers exactly one tool. The gate, audit log and
proposal store were removed on 2026-05-24. `packages/governance` still compiles and passes 57
tests, and is imported by nothing at runtime. This is why
[`RETENTION.md`](./docs/RETENTION.md) governs the streams that actually emit, and why two of
the four dashboard metrics the brief named ship disabled rather than displaying a constant zero.

**3. The hardened systemd unit in the Backbone repo is not the one installed.** The repo
contains a genuinely well-hardened `hermes.service` — `ProtectSystem=strict`,
`NoNewPrivileges`, `SystemCallFilter`, `MemoryMax=1G`, a restart burst cap. The unit actually
running as `hermes-gateway.service` has none of it, and sets `StartLimitIntervalSec=0`
(restart forever, no cap). So Phase 1 does not *preserve* a security posture; it *applies*, for
the first time, the posture the repo always intended. Better outcome, different claim.

## The decision the rest follows from

MCP servers on the host are **not services**. The gateway forks them and speaks JSON-RPC over
inherited file descriptors. A sidecar cannot receive that — a sidecar has its own process
namespace, and a parent in one container cannot `fork()` a binary in another.

So either the MCP server ships inside the gateway image and keeps being forked, or it gets a
network transport and becomes a real Service. This repo does the second, and the deciding reason
is Phase 4: **a forked child makes the gateway→tool call a function call inside one process, and
no NetworkPolicy can ever see it.** Porting it to HTTP turns an invisible trust relationship
into one declared in YAML and enforced by the CNI.

The port is in [`services/notify-mcp/`](./services/notify-mcp/) — it also replaced two `curl`
subprocesses with `fetch`, which is what makes a distroless image possible.

## Verified vs. not

**Verified locally** (29 rows in [`VALIDATION.md`](./VALIDATION.md)) — the MCP server compiles,
22 unit tests pass, the HTTP transport answers repeated requests, a `tools/call` reaches a sink
with correct headers, `/metrics` moves, the chart lints and renders across four Kubernetes
versions, 21 parity constraints hold, and SQLite's online backup produces an integrity-checked
copy of a live 22 MB WAL-mode database in 0.18 s.

**Verified in CI** (8 rows) — both images build; the runtime image is asserted to have no shell
and run as uid 65532; the built container serves MCP over HTTP; the chart validates on
Kubernetes 1.29 through 1.32.

**Verified on a live cluster** (23 rows) — k3s v1.36.2 + Cilium 1.16.5:

| | |
|---|---|
| A disallowed pod-to-pod connection is **refused**, an allowed one still works | both directions, `evidence/2026-07-25/networkpolicy-proof.txt` |
| A real **OIDC login** through Keycloak reaches the dashboard | 5-step auth-code flow, `sso-proof.txt` |
| **sealed-secrets** round-trips 41 real keys | controller decrypts a committable manifest into a live Secret |
| `readOnlyRootFilesystem: true` **holds** for the gateway | 0 errors once every path the systemd unit named was mounted |
| **Cost per task: $0.00767** | 1,111 sessions, $8.52 estimated, from `state.db.sessions` |
| **Recall latency ~3.8 ms**, 0 probe failures | measured by a prober, not read |
| Workflow runs | gmail-intake 2,895 · memory-ingest 2,352 |

**Still not verified** — seven consecutive days of operation, and per-span tracing.

**Every phase gate is unmet.** The original brief required stopping at each gate until I had
observed something running; this build was directed to produce the full artifact set without
provisioning paid infrastructure, so no gate has been cleared. That deviation is recorded in
[`VALIDATION.md §5`](./VALIDATION.md) rather than glossed over, and the artifacts for a phase
existing is not the same thing as that phase's gate passing.

## One thing that is known to be wrong

k3s ships **flannel**, which does not enforce NetworkPolicy. Applying the policies in
`charts/backbone/templates/networkpolicy.yaml` to a stock k3s cluster produces objects that are
accepted by the API server and enforced by nothing.

Making Phase 4's gate ("a disallowed pod-to-pod connection is refused") achievable means
installing k3s with `--flannel-backend=none --disable-network-policy` and bringing a CNI that
enforces — Calico or Cilium. That is a cluster-bootstrap decision, not a chart value, and it
belongs in the install runbook that does not exist yet.

I would rather write this down than let someone apply the policies and believe they are
protected.

## Running the static checks

Two static binaries, no daemon, no cluster:

```bash
./scripts/validate.sh        # kubeconform, helm lint/template, parity, secret scan
./scripts/parity-check.sh    # 21 constraints where chart and manifests must agree

cd services/notify-mcp && npm ci && npx tsc && node --test dist/*.test.js
```

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) additionally does what this
droplet cannot: builds the images, proves the runtime image has no shell and runs as uid 65532,
and builds the gateway image. That last job is `continue-on-error` on purpose, and it earned it:
the first run failed and the failure turned out to be the most useful thing in the project so
far — it revealed that the running checkout carries a local patch my Phase 0 audit missed
([`docs/OPERATIONS.md`](./docs/OPERATIONS.md)). It builds green now.

## What is deliberately not here

- **`docs/WHY-NOT-COMPOSE.md` is nearly empty, on purpose.** It has exactly **one** entry, earned
  on 2026-07-25 when Compose needed a privileged helper container to do what `fsGroup` does in
  two declarative lines. The rest waits for Phase 6. Writing the generic answer now would be
  inventing the most interesting result in the project.
- **`ask-hermes` and the voice sidecar** are not containerized. They are real services on the
  host, and they add no Kubernetes concept the notify MCP does not already demonstrate. Scoped
  out rather than padded in.
- **A SOC 2 control mapping.** That is `agent-fleet-on-eks`'s deliverable. Copying it here would
  be a mapping to controls that do not apply on this substrate.

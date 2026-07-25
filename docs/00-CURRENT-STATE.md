# 00 — Current state: what is actually running

**Audit date:** 2026-07-25
**Host:** DigitalOcean droplet, hostname `Backbone`, Ubuntu 24.04.3 LTS, kernel 6.8.0-117, KVM
**Shape:** 1 vCPU · 1.9 GiB RAM · 2.0 GiB swap · 48 GB disk (28 GB used, 59%)

This is an inventory, not a design. Everything below was read off the running machine on the
audit date. Commands used are shown so any line here can be re-derived. Where a claim could not
be established by observation it is marked **UNVERIFIED** rather than guessed.

Secrets are redacted. Token *names* appear; token *values* never do.

The Tailscale tailnet name and node IP are redacted too (`<tailnet>.ts.net`, `100.x.x.x`).
They are not credentials, but Funnel is **on** for that hostname, so publishing it alongside
the exact webhook paths in §5 would hand any reader of this public repository a working map
of a live, internet-reachable surface whose only authentication is a shared secret.

---

## 1. The single most important finding

**There is no container runtime on this host.**

```
$ which docker podman containerd
(no output)
$ docker ps
bash: docker: command not found
```

The whole system is **systemd units on bare Ubuntu**, sharing one filesystem and one user
(`backbone`, uid 1000). There is no Postgres, no Redis, no message broker, and no network
service mesh. Inter-process communication is: **stdio pipes between parent and child
processes**, plus **loopback HTTP**.

This corrects the assumption in the original project brief, which anticipated "Postgres, Redis,
notification bridge — may be containerized on the live host." They are not. There is nothing to
lift-and-shift; Phase 1 is a genuine containerization, not a migration of existing images.

## 2. The second most important finding

**The Backbone governance gate is not in the request path.**

The brief describes `packages/governance` and `adapters/mcp-governance` as the workloads to
migrate. What is actually true:

| Claim | Reality |
|---|---|
| `adapters/mcp-governance` is running | **Yes** — 3 processes, one per Hermes host process |
| ...as a governance gate | **No.** The package is `@backbone/mcp-notify`. It registers exactly one tool: `mcp_backbone_notify` |
| `packages/governance` is running | **No.** It is compiled, tested (57 tests), and imported by nothing at runtime |

Evidence:

```
$ grep "MCP server 'backbone'" ~/.hermes/logs/agent.log | tail -1
2026-07-25 15:51:37,910 INFO tools.mcp_tool: MCP server 'backbone' (stdio):
  registered 1 tool(s): mcp_backbone_notify
```

The directory name `adapters/mcp-governance` is a fossil. `Backbone/deploy/healthcheck.sh`
records why, in a comment dated 2026-05-24:

> Architecture (post-teardown 2026-05-24): vanilla Hermes + one custom MCP (`backbone_notify`)
> + a webhook route that delivers to Telegram. There is no longer a governance gate, audit log,
> or proposal store — those were ripped out in favor of leaning on Hermes-native primitives.

The governance store from before the teardown is still on disk, frozen:
`~/.hermes/archive-backbone-2026-05-24/` — 14 KB of `governance-audit.jsonl` and two proposal
records.

**Consequence for this project:** the "governance JSONL audit stream" that Phase 4 is supposed
to give a retention policy to **does not currently emit**. Phase 4 has to either re-wire the
gate or scope the retention policy to the streams that *do* emit. That decision is made in
[`docs/RETENTION.md`](./RETENTION.md), not assumed here.

## 3. Process topology

The gateway is a **parent process that forks its own tool servers over stdio.** This is the
fact that most constrains the Kubernetes design.

```
systemd
├── hermes-gateway.service        PID 890283  hermes … gateway run          167 MB RSS
│   ├── node …/mcp-governance/dist/server.js      (stdio child)              65 MB
│   ├── node …/bin/vapi-mcp-wrapper.mjs           (stdio child)              71 MB
│   └── node …/plugins/platforms/photon/sidecar/index.mjs                    94 MB
├── hermes-voice.service          PID 890288  voice-sidecar/server.py         51 MB
│   └── hermes acp                PID 890289                                172 MB
│       ├── node …/mcp-governance/dist/server.js  (stdio child)              66 MB
│       └── node …/bin/vapi-mcp-wrapper.mjs       (stdio child)              71 MB
├── hermes-dashboard.service      PID 629241  hermes dashboard               13 MB
│   ├── node …/mcp-governance/dist/server.js      (stdio child)              23 MB
│   └── node …/bin/vapi-mcp-wrapper.mjs           (stdio child)              15 MB
├── ask-hermes.service            PID 890285  ask-hermes/server.py            22 MB
└── ntfy.service                  PID 186501  ntfy serve                      15 MB
```

Read that carefully: **the MCP servers are not services.** They are forked children, one copy
per Hermes host process, communicating over inherited file descriptors. Three copies of the
same Node program are resident because three Hermes processes each spawned their own.

`ps -eo pid,ppid,user,rss,etime,comm,args --sort=-rss` produced the RSS figures.

## 4. Systemd units

| Unit | Enabled | Restart | Exec | Notes |
|---|---|---|---|---|
| `hermes-gateway` | yes | `always`, 5 s | `python -m hermes_cli.main gateway run` | `TimeoutStopSec=210`, `KillMode=mixed`, `StartLimitIntervalSec=0` (no burst cap), `RestartForceExitStatus=75` |
| `hermes-dashboard` | yes | `always`, 10 s | `hermes dashboard --host 127.0.0.1 --port 9119` | logs to files, not journal |
| `hermes-voice` | yes | `on-failure`, 10 s | `voice-sidecar/server.py` | warm ACP session for mid-call answers |
| `ask-hermes` | yes | `on-failure`, 5 s | `ask-hermes/server.py` | `PartOf=hermes-gateway.service` |
| `ntfy` | yes | `on-failure` | `ntfy serve --no-log-dates` | runs as `ntfy` user, `AmbientCapabilities=CAP_NET_BIND_SERVICE` |

**None of the running units use the hardened profile.** The repo contains a well-hardened
`deploy/hermes.service` (`ProtectSystem=strict`, `NoNewPrivileges`, `SystemCallFilter`,
`MemoryMax=1G`, and a 5-restarts-per-5-minutes burst cap), but the unit actually installed as
`hermes-gateway.service` is a **different, unhardened file**. It sets `Environment=` lines and
`Restart=always` and nothing else.

`systemctl cat hermes-gateway` — no `Protect*`, no `NoNewPrivileges`, no `MemoryMax`,
`StartLimitIntervalSec=0`.

This matters: the brief says "preserve the security posture already in
`hermes-gateway.service` — that unit is well-hardened." **The hardened unit is aspirational,
not deployed.** Phase 1 therefore does not *preserve* a posture; it *applies*, for the first
time, the posture the repo always intended. That is a stronger outcome, but it must be stated
honestly. Mapping in [`01-CONTAINERIZATION.md`](./01-CONTAINERIZATION.md).

## 5. Listening sockets

```
$ ss -tlnp
```

| Bind | Port | Process | Reachable from |
|---|---|---|---|
| `0.0.0.0` | 8645 | `hermes` (gateway webhook) | **anywhere the firewall allows** |
| `127.0.0.1` | 9119 | `hermes` (dashboard) | loopback only — reached by SSH tunnel |
| `127.0.0.1` | 8646 | `python3` (ask-hermes) | loopback only |
| `127.0.0.1` | 8647 | `python3` (voice-sidecar) | loopback only |
| `127.0.0.1` | 8789 | `node` (photon sidecar) | loopback only |
| `*` | 2586 | `ntfy` | all interfaces |
| `100.x.x.x` | 443, 8443 | tailscaled | tailnet + funnel |
| `0.0.0.0` | 22 | sshd | anywhere |

Public exposure is mediated by **Tailscale**, not by an ingress controller:

```
$ tailscale serve status
# Funnel on:
#     - https://backbone.<tailnet>.ts.net
https://backbone.<tailnet>.ts.net:8443 (tailnet only)
|-- / proxy http://localhost:2586
https://backbone.<tailnet>.ts.net (Funnel on)
|-- /photon/webhook         proxy http://localhost:8788/photon/webhook
|-- /tool/ask-hermes        proxy http://localhost:8646/tool/ask-hermes
|-- /webhooks/vapi-call-end proxy http://localhost:8645/webhooks/vapi-call-end
```

Three paths are **Funnel-exposed to the public internet**. Authentication on those paths is a
shared secret in the request body/header (`PHOTON_WEBHOOK_SECRET`, `WEBHOOK_SECRET`), not an
identity provider. The dashboard — the one surface with a UI — is not exposed at all; it is
reached by tunnelling loopback. `dashboard.oauth.client_id` and `dashboard.basic_auth.username`
in `config.yaml` are both empty strings.

**There is no SSO anywhere in the current system.** That is the honest baseline Phase 4
improves on.

Note the mismatch: `tailscale serve` forwards `/photon/webhook` to **8788**, but the photon
sidecar listens on **8789**. Either a second listener exists that `ss` did not attribute, or
this route is broken. **UNVERIFIED** — I did not send a probe request, because doing so would
have touched the live message path. Flagged for the operator.

## 6. State — what is on disk

Total `~/.hermes`: **9.4 GB**. Of that, 8.0 GB is the `hermes-agent` checkout + venv (code, not
data). Actual state:

| Store | Size | Tables / contents | Owner |
|---|---|---|---|
| `state.db` | **237 MB** | 18 tables — `messages` + FTS5 and trigram indexes | gateway |
| `memory_store.db` | 21 MB | 25 tables — `facts`, `entities`, `edges`, `chunk_members`, `decision_log`, `gist_extracted` | gateway (hybrid memory plugin) |
| `kanban.db` | 140 KB | 8 tables — `tasks`, `task_runs`, `task_events`, `task_comments` | gateway |
| `verification_evidence.db` | 32 KB | `verification_events`, `verification_state` | gateway |
| `response_store.db` | 20 KB | `conversations`, `responses` | gateway |
| `cron/jobs.json` | 16 KB | 10 job definitions | gateway (in-process scheduler) |
| `state-snapshots/` | 192 MB | rolling snapshots | gateway |
| `profiles/` | 117 MB | per-profile state | gateway |
| `logs/` | 38 MB | `agent.log`, `hermes-voice.log`, `ask-hermes.log` | all |
| `backups/`, `backup/` | 712 MB | local backup copies | `hermes-backup` cron |

Every one of these is **SQLite on the local filesystem**, written by **one process**. There is
no networked datastore. This is the central constraint on the Kubernetes design and is worked
through in [`02-STATE-TRADEOFFS.md`](./02-STATE-TRADEOFFS.md).

## 7. Scheduled work

**Hermes in-process cron** (`~/.hermes/cron/jobs.json`) — 10 jobs, 8 enabled:

| Job | Schedule | Enabled |
|---|---|---|
| `memory-ingest` | every 15m | yes |
| `gmail-intake` | every 30m | yes |
| `memory-feedback` | `45 3 * * *` | yes |
| `memory-consolidate` | `0 4 * * 1` | yes |
| `hermes-backup` | `0 7 * * *` | yes |
| `ontology-review-nudge` | `0 9 * * 1` | yes |
| `svn-monthly-report` | `0 13 1 * *` | yes |
| `AC Vinegar Reminder` | `0 10 10 * *` | yes |
| `calendar-sync` | every 5m | **no** |
| `ticket-factory-daily` | `0 22 * * *` | **no** |

These run **inside the gateway process**. They are not systemd timers and not separate
processes. If the gateway is down, none of them fire and none of them backfill.

**System crontab** (`crontab -l`) — one entry:

```
0 3 * * * /home/backbone/Backbone/deploy/backup-audit.sh >> /home/backbone/.hermes/backup.log 2>&1
```

## 8. Secrets

`~/.hermes/.env` — **38 environment variables**, plaintext, mode `0600`, loaded by
`EnvironmentFile=` in two units. Names only:

```
BACKBONE_NTFY_TOPIC          OPENROUTER_API_KEY        TELEGRAM_BOT_TOKEN
BROWSERBASE_ADVANCED_STEALTH PHOTON_ALLOWED_USERS      TELEGRAM_ALLOWED_USERS
BROWSERBASE_PROXIES          PHOTON_HOME_CHANNEL       TELEGRAM_HOME_CHANNEL
BROWSER_INACTIVITY_TIMEOUT   PHOTON_HOME_CHANNEL_...   TELEGRAM_HOME_CHANNEL_THREAD_ID
BROWSER_SESSION_TIMEOUT      PHOTON_PROJECT_ID         TERMINAL_LIFETIME_SECONDS
BROWSER_USE_API_KEY          PHOTON_PROJECT_SECRET     TERMINAL_MODAL_IMAGE
FIRECRAWL_API_KEY            PHOTON_WEBHOOK_BIND       TERMINAL_TIMEOUT
GITHUB_BACKUP_REPO_URL       PHOTON_WEBHOOK_SECRET     VAPI_TOKEN
GITHUB_BACKUP_TOKEN          SIMMER_API_KEY            VISION_TOOLS_DEBUG
HERMES_DASHBOARD_SESSION_... SIMMER_WEATHER_LOCATIONS  WEBHOOK_ENABLED / _HOST / _PORT / _SECRET
IMAGE_TOOLS_DEBUG            WEB_TOOLS_DEBUG           XAI_API_KEY
MOA_TOOLS_DEBUG
```

Additional credential material **outside** `.env`, which any migration must not miss:

| File | Contains |
|---|---|
| `~/.hermes/auth.json` | provider auth |
| `~/.hermes/google_token.json`, `google_client_secret.json` | Workspace OAuth (work account) |
| `~/.hermes/calendar-sync/google_token_personal.json`, `client_secret.json` | Workspace OAuth (personal) |
| `~/.hermes/ga4-service-account.json` | GA4 service account |
| `~/.hermes/config.yaml` | **contains secrets inline** — `mcp_servers.vapi.env.VAPI_TOKEN` and `platforms.webhook.extra.secret` are literal values in the YAML |
| `/etc/ntfy/server.yml` | `upstream-access-token` in plaintext |

That last pair matters. `config.yaml` is not purely configuration — it is **configuration with
credentials embedded**, so it cannot become a plain ConfigMap. Split described in
[`04-SECRETS.md`](./04-SECRETS.md).

## 9. Per-service table

| Service | Language / runtime | Entrypoint | State it owns | Talks to | What breaks if it dies |
|---|---|---|---|---|---|
| **hermes-gateway** | Python 3.11.15, `hermes-agent` v0.18.0 (NousResearch, upstream `07e97d2f`) | `python -m hermes_cli.main gateway run` | `state.db`, `memory_store.db`, `kanban.db`, `response_store.db`, `verification_evidence.db`, `cron/jobs.json`, `state-snapshots/`, `profiles/` | OpenRouter (egress), Telegram API, ntfy, Google APIs, forks all MCP children | **Everything.** All chat channels, all 8 cron jobs, all memory writes, all tool calls. Sole writer to every store. Total outage. |
| **backbone-notify MCP** | TypeScript → Node 22, `@modelcontextprotocol/sdk` ^1.18 | `node dist/server.js` (stdio) | none | ntfy over HTTPS | Agent loses `mcp_backbone_notify`; push notifications stop. Chat still works. Gateway does not crash. |
| **vapi MCP wrapper** | Node 22 | `node bin/vapi-mcp-wrapper.mjs` (stdio) | none | Vapi API | 13 voice-call tools disappear. Outbound calling stops. |
| **hermes-dashboard** | Python (same venv) | `hermes dashboard --host 127.0.0.1 --port 9119` | none (reads gateway stores) | reads `~/.hermes` | Web UI unreachable. No agent impact. |
| **hermes-voice** | Python 3.11 | `voice-sidecar/server.py` | none | spawns `hermes acp`; serves 127.0.0.1:8647 | Mid-call voice answers fail; calls connect but the agent cannot answer questions. |
| **ask-hermes** | Python 3 (system, **not** the venv) | `/usr/bin/python3 ask-hermes/server.py` | none | 127.0.0.1:8647 → voice sidecar; public via Funnel | Vapi mid-call tool webhook 502s. Same user-visible symptom as above. |
| **ntfy** | Go (distro package) | `ntfy serve --no-log-dates` | `/var/cache/ntfy/cache.db` | upstream `ntfy.sh`; serves :2586 | Push notifications queue upstream or drop. Secondary channel only — Telegram is primary. |
| **photon sidecar** | Node 22 | `plugins/platforms/photon/sidecar/index.mjs` | none | Photon relay (iMessage); 127.0.0.1:8789 | iMessage channel drops. Telegram unaffected. |
| **tailscaled** | Go | system service | `/var/lib/tailscale` | tailnet + Funnel | **All external reachability**: dashboard tunnel, ntfy UI, all three Funnel webhook paths. |

## 10. Failure domains, as they exist today

1. **One process is the whole system.** `hermes-gateway` is the sole writer to five SQLite
   databases, the host of the cron scheduler, and the parent of every MCP tool server. There is
   no component whose failure is partial.
2. **No restart burst cap.** `StartLimitIntervalSec=0` on the installed unit means a crash-loop
   restarts forever at 5-second intervals. The repo's hardened unit caps this at 5 per 300 s;
   that file is not installed.
3. **1.9 GiB RAM, ~1.2 GiB in use, 762 MiB available.** Resident set of the Hermes tree alone is
   roughly 700 MB across 8 processes. A 2 GiB swapfile was added on 2026-05-26 specifically
   because OOM was freezing the host. There is no memory limit on any unit.
4. **Reachability depends on a single userspace daemon.** If `tailscaled` stops, every inbound
   path except SSH-on-22 disappears.
5. **Backups are on the same disk.** 712 MB of backups in `~/.hermes/backup*`. There is a
   `GITHUB_BACKUP_REPO_URL` suggesting off-host copies; **UNVERIFIED** — I did not confirm the
   remote is current.

## 11. What Kubernetes must therefore respect

Carried into the design, not decided here:

- The gateway is a **stateful singleton**. `replicas: 1`, `Recreate` strategy, RWO volume. It
  cannot be scaled horizontally without upstream changes to SQLite ownership and the in-process
  scheduler.
- **stdio MCP children cannot become sidecars.** A stdio MCP server is forked by its parent and
  speaks over inherited file descriptors. A sidecar container has a separate process namespace,
  so the parent cannot fork into it. The choice is: ship the MCP binary *inside* the gateway
  image, or convert it to a network transport. Resolved in
  [`01-CONTAINERIZATION.md`](./01-CONTAINERIZATION.md).
- **`config.yaml` is a secret**, not a ConfigMap.
- **The audit stream the brief assumes does not exist.** Retention policy must be written
  against real streams.
- **1 vCPU / 2 GiB will not host a control plane plus this workload plus Keycloak plus
  Prometheus.** The target cluster has to be a different, larger machine; this droplet is the
  source, not the destination.

---

## Reproducing this audit

```bash
hostnamectl; free -h; nproc; df -h /
systemctl list-units --type=service --state=running --no-pager
systemctl cat hermes-gateway hermes-dashboard hermes-voice ask-hermes ntfy
ss -tlnp
ps -eo pid,ppid,user,rss,etime,comm,args --sort=-rss | head -25
tailscale serve status
du -sh ~/.hermes/*| sort -rh | head -12
python3 -c "import sqlite3;c=sqlite3.connect('file:$HOME/.hermes/state.db?mode=ro',uri=True);\
print([r[0] for r in c.execute(\"select name from sqlite_master where type='table'\")])"
grep -oE '^[A-Z0-9_]+=' ~/.hermes/.env | tr -d '='     # names only, never values
grep "MCP server" ~/.hermes/logs/agent.log | tail -5
crontab -l
```

All commands are read-only. Nothing in this audit modified the running system.

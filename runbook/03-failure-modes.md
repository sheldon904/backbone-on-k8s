# 03 — Failure modes

Every failure below **happened** during the 2026-07-25 reference install, in this order. None
are hypothetical. Narrative versions, including the wrong hypotheses, are in
[`docs/OPERATIONS.md`](../docs/OPERATIONS.md).

The common thread is worth stating once: **most of them presented as healthy.** Pods `Running`,
probes passing, `helm status: deployed`, a cron ticker beating on time. Only a test that
asserted the *specific* behaviour caught them.

---

## F1 — apt lock held on first boot

**Symptom.** `E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process (apt-get)`

**Cause.** cloud-init runs unattended-upgrades on first boot.

**Fix.** Wait, don't fight it.

```bash
cloud-init status --wait
for i in $(seq 1 60); do fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break; sleep 10; done
```

---

## F2 — gateway CrashLoops on a root-owned volume *(Compose only)*

**Symptom.**
```
PermissionError: [Errno 13] Permission denied: '/home/hermes/.hermes/logs'
```

**Cause.** Docker creates named volumes root-owned. The container runs as uid 10001 because the
image is hardened, so it has a writable mount it does not own.

**Fix.** Kubernetes handles this declaratively and needs nothing:

```yaml
securityContext: { fsGroup: 10001, fsGroupChangePolicy: OnRootMismatch }
```

Compose has no equivalent — it needs a privileged one-shot service plus a `depends_on`
*condition*, which must be map form (mixing list and map silently fails to parse). This is the
first earned entry in [`docs/WHY-NOT-COMPOSE.md`](../docs/WHY-NOT-COMPOSE.md).

---

## F3 — Cilium install fails on a renamed value

**Symptom.**
```
Error: INSTALLATION FAILED: execution error at (cilium/templates/cilium-configmap.yaml:1011:8):
Value ipam.operator.clusterPoolIPv4PodCIDR removed, use ipam.operator.clusterPoolIPv4PodCIDRList instead
```

**Fix.** It is a **list** now:

```bash
--set 'ipam.operator.clusterPoolIPv4PodCIDRList={10.42.0.0/16}'
```

**Watch for:** if you suppress helm's output, this fails silently and the node sits `NotReady`
with no explanation. `helm list -A` showing no release is the tell.

---

## F4 — sealed-secrets Helm repo 404s

**Symptom.** `failed to fetch https://bitnami-labs.github.io/sealed-secrets/index.yaml : 404 Not Found`

**Fix.** Use the release manifest, and match `kubeseal` to the controller version:

```bash
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.27.1/controller.yaml
```

---

## F5 — the dashboard has no web assets

**Symptom.** Gateway pod is `1/2`. It is **not** the gateway:
```
✗ --skip-build was passed but no web dist found at:
  /opt/venv/lib/python3.11/site-packages/hermes_cli/web_dist
```

**Cause.** The pip wheel ships no built frontend. `find /opt/venv -name web_dist` returns
nothing. The dashboard needs `npm run build -w web`, which a Python package cannot provide.

**Fix (implemented).** A `node:22-bookworm-slim` stage in the gateway Dockerfile builds
upstream's `web` workspace and the result is copied into the installed package:

```dockerfile
FROM node:22-bookworm-slim AS webbuild
COPY --from=build /src/hermes-agent /src/hermes-agent
WORKDIR /src/hermes-agent
RUN npm install --workspace web --no-audit --no-fund && npm run build -w web

# ...then in the runtime stage:
COPY --from=webbuild --chown=10001:10001 \
     /src/hermes-agent/hermes_cli/web_dist \
     /opt/venv/lib/python3.11/site-packages/hermes_cli/web_dist
```

Measured: ~24 s, 2.9 MB, image grows 541 MB → 546 MB. `--chown` at COPY time matters — the
root filesystem is read-only, so nothing can fix ownership at runtime.

Alternatively `--set gateway.dashboard.enabled=false`, but that removes the only web surface
and leaves SSO nothing to sit in front of.

---

## F6 — NetworkPolicy: every pod Running, nothing able to talk

**The most dangerous failure in this list**, because the cluster looks perfect.

**Symptom.** The negative test passes — a non-allow-listed pod is refused. Then the **positive
control fails too**: the gateway, which has an explicit allow rule, also times out reaching
notify-mcp.

**Cause.** NetworkPolicy is directional, and only half of each flow was written. Ingress was
granted on the destination; **nothing granted egress from the source**. Compounding it, the
"allow the internet except every RFC1918 range" rule *denies in-cluster traffic*, because
ClusterIPs live in `10.43.0.0/16` — inside the excluded `10.0.0.0/8`.

**Fix.** Every in-cluster flow needs an explicit egress policy on the source
(`networkpolicy.yaml` rules 3b and 4b).

**Prevention.** Always run a positive control. *Refused* and *broken* are the same observation,
and a negative test alone cannot tell them apart.

---

## F7 — `readOnlyRootFilesystem` and the path that was named all along

**Symptom.** Pod `Running`, `restarts=0`, but the logs repeat:
```
OSError: [Errno 30] Read-only file system: '/home/hermes/.local'
```

**Cause.** The mapping from systemd to volumeMounts was incomplete. The source unit says:

```
ReadWritePaths=/home/backbone/.hermes /home/backbone/.local /home/backbone/.cache
```

Two of three were carried over.

**Fix.** Mount an `emptyDir` at `/home/hermes/.local`. **Do not** disable
`readOnlyRootFilesystem` — the correct response to a read-only error is another mount, not
relaxing the flag. With `.local` mounted the flag holds and the error count is zero.

**Lesson.** The systemd unit was a complete specification of the writable paths. Transcribe it
in full.

---

## F8 — audit stream silently disabled

**Symptom.** No audit files. `/var/lib/backbone/audit` does not exist. Nothing crashed.

**Cause.** The emitter defaults to that path, nothing mounted it, and the root filesystem is
read-only — so `init()` latched `disabled` and degraded to a structured stderr line. Working as
designed, and the feature was silently absent.

**Fix.** Mount a PVC and set `BACKBONE_AUDIT_DIR` (`notifyMcp.audit.enabled=true`).

**Note.** RWO is only safe here because each replica writes its own `audit-<pod>.jsonl` **and**
both land on the same node. A multi-node cluster needs RWX.

---

## F9 — `helm upgrade --reuse-values` drops new keys

**Symptom.** A chart change adds a PVC. `helm upgrade --reuse-values` reports success, revision
increments, and the PVC never appears.

**Cause.** `--reuse-values` uses the *previous release's* values and ignores new chart defaults,
so newly-added keys render empty.

**Fix.** Pass the full `--set` list, or use `--reset-then-reuse-values`.

---

## F10 — ntfy returns 403 on every publish

**Symptom.** `{"ok":false,"status":403,"error":"ntfy HTTP 403"}`

**Cause.** Not a network fault — the full path worked. `auth-default-access: deny-all` is set
deliberately, because an unauthenticated ntfy lets anything that can reach it publish to any
topic.

**Fix.**
```bash
kubectl -n backbone exec backbone-ntfy-0 -- ntfy access '*' '<topic>' write-only
kubectl -n backbone delete pod backbone-ntfy-0     # auth is read at startup
```

The pod restart matters — granting access without it leaves the running process on stale auth.

---

## F11 — oauth2-proxy CrashLoops on OIDC discovery

**Symptom.**
```
Failed to initialise OAuth2 Proxy: ... dial tcp 10.43.59.154:8080: i/o timeout
```

**Cause.** Keycloak is a ClusterIP in `10.43.0.0/16` — inside the `10.0.0.0/8` the
external-egress rule excludes. Enabling `sso.enabled` is not sufficient; the path to the IdP
needs its own egress policy.

**Fix.** Rule 5b in `networkpolicy.yaml`, gated on `sso.enabled`. **It only takes effect on the
next `helm upgrade`**, so the first rollout after enabling SSO will still fail.

---

## F12 — Keycloak returns HTTP 400 on the authorization request

**Cause.** oauth2-proxy *derives* its callback from the request host and forces `https` whenever
`--cookie-secure=true`. It sent `https://127.0.0.1:4180/oauth2/callback` at a plain-http
listener, and no registered redirect URI matched.

**Fix.** Set `sso.redirectUrl` explicitly and register the identical string on the client. Do
not try to guess what host it will pick.

---

## F13 — the OIDC callback returns 403, `CSRF cookie not found`

**Symptom.** `initialize` works, the login form renders, Keycloak issues an authorization
code — then the callback 403s with:
```
CSRF cookie with name '_oauth2_proxy_csrf' was not found
```

**Cause. This is not a bug.** The CSRF cookie is set `Secure`, so no client sends it back over
plain http. It was issued at step 1 and dropped by step 4. `--cookie-secure=true` is preventing
a session from being established over an insecure transport, which is its entire purpose.

**Fix.** Terminate TLS in front of oauth2-proxy. For an in-cluster verification only,
`sso.cookieSecure=false` exercises the flow — the value exists for that and defaults to `true`.
Capture both states: a login that is *correctly refused* is as much evidence as one that
succeeds.

---

## F14 — every cron job fails while the scheduler reports perfect health

**The most misleading failure in this list.** Ticker heartbeat current to the second,
`ticker_last_success` equal to it, `hermes cron status` reporting "3 active job(s)". Zero jobs
had ever run. Four separate causes, in the order they surface:

**14a — the scripts were never transferred.** `Script not found: .../scripts/memory-ingest.sh`.
The job *table* comes across in a state restore; the scripts it points at do not.

**14b — the scripts hardcode the source install layout.**
```sh
PY="$HERMES_HOME/hermes-agent/venv/bin/python3"
```
The container's interpreter is at `/opt/venv`. Fixed with a shim — as an **initContainer**, not
a Dockerfile `RUN`, because `~/.hermes` is a mounted PVC and anything baked into the image is
masked by the mount.

**14c — the shim cannot be a symlink.**
```
via /opt/venv/bin/python                        -> prefix=/opt/venv,  sqlite_vec OK
via .../hermes-agent/venv/bin/python3 (symlink) -> prefix=/usr/local, ModuleNotFoundError
```
PEP 405 resolves `sys.prefix` from the **invoked** path: Python looks for `pyvenv.cfg` beside
the executable it was called as, finds none next to the symlink, and silently falls back to the
system interpreter. The symptom is `ModuleNotFoundError` for a package `pip list` shows as
installed. Use wrapper scripts that `exec` the real binary, and have the initContainer *assert*
the shim reaches the venv so a regression fails pod start instead of every cron job silently.

**14d — `>` follows a stale symlink.** Writing the wrapper failed with
`Read-only file system` naming a path plainly on a writable PVC — an earlier symlink was still
there and redirection followed it to `/opt/venv/bin/python` on the read-only root. `rm -f`
first.

**Also:** the memory plugin's deps (`sqlite_vec`, `numpy`, `networkx`) are in no upstream extra.
Bake them into the image.

**Verify by reading the per-run output file**, never the exit code:
```bash
kubectl -n backbone exec deploy/backbone-gateway -c gateway -- sh -c \
  'cat "$(ls -t /home/hermes/.hermes/cron/output/*/* | head -1)"'
```

---

## F15 — metrics exist, are scraped, and are unqueryable

Three at once, none of which produced an error — all produced *absence*.

**15a — `job` is a reserved Prometheus label.** `backbone_workflow_runs_total{job="gmail-intake"}`
returned no data while the exporter plainly emitted it: the scrape config **overwrites** `job`
with the scrape job name, collapsing every series into `{job="backbone-exporter"}`. Never use
`job` as your own label.

**15b — a target read `health=down` while perfectly healthy.** notify-mcp had no scrape allow
rule; the exporter did. Prometheus could not reach it, so every notify panel would have been
blank — reading as "the service is broken" rather than "monitoring cannot see it".

**15c — `sum(a) / b` yields an empty vector.** `sum()` strips labels, the right side keeps
`instance`/`pod`/`job`, the vector match finds nothing. Not an error: an empty result, which
renders as a dash. Use `sum()` on both sides.

**Plus:** `ruleSelectorNilUsesHelmValues` and `serviceMonitorSelectorNilUsesHelmValues` default
to **true**, so the operator ignores anything not carrying its own release label. Zero rules
loaded, silently.

**Prevention.** Query every metric by name and assert a value comes back. A blank panel and a
healthy-idle panel look identical.

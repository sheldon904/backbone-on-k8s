# 02 — Install

The procedure as executed on 2026-07-25. Roughly 25 minutes if nothing surprises you; the
reference run took ~90 because six things did — all of them in
[`03-failure-modes.md`](./03-failure-modes.md).

Run everything as `root` on the target host unless noted.

---

## Step 1 — Base host

```bash
# Wait for cloud-init. Racing it means fighting apt for the dpkg lock.
cloud-init status --wait
for i in $(seq 1 60); do
  fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || break
  sleep 10
done

apt-get update -qq && apt-get install -y -qq git curl jq sqlite3

# Firewall: deny inbound except SSH and the kube API; allow the cluster CIDRs.
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 6443/tcp
ufw allow from 10.42.0.0/16      # k3s pod CIDR
ufw allow from 10.43.0.0/16      # k3s service CIDR
ufw allow in on tailscale0       # if using Tailscale
ufw --force enable
```

## Step 2 — Tailscale (optional; free TLS, no DNS)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey="tskey-auth-..." --hostname=backbone-k8s
tailscale ip -4
```

The node is then reachable at `backbone-k8s.<tailnet>.ts.net` and `tailscale cert` will issue a
real LetsEncrypt certificate for it — no DNS records, no public exposure, which is what Keycloak
needs in Step 8.

## Step 3 — Images

Either pull from a registry, or build locally and import into containerd:

```bash
git clone https://github.com/sheldon904/backbone-on-k8s /opt/backbone-on-k8s
cd /opt/backbone-on-k8s
docker build -t backbone/notify-mcp:dev     services/notify-mcp        # ~19 s
docker build -t backbone/hermes-gateway:dev services/hermes-gateway    # ~109 s

# k3s uses containerd, not the Docker daemon. Import explicitly.
for img in backbone/notify-mcp:dev backbone/hermes-gateway:dev; do
  docker save "$img" | k3s ctr images import -
done
```

If you use `--set image.pullPolicy=Never`, **every** image must be imported, including
third-party ones (`docker.io/binwiederhier/ntfy:v2.11.0`). Missing one yields
`ErrImageNeverPull`.

## Step 4 — Optional: prove the Compose path first

Not required for Kubernetes, but it is the Phase 1 gate and a useful smoke test of the images:

```bash
cd compose && cp .env.example .env && $EDITOR .env
docker compose up -d
cd .. && ./scripts/healthcheck.sh      # expect GREEN on 7 checks
docker compose -f compose/docker-compose.yml down
```

## Step 5 — k3s

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="\
  --flannel-backend=none --disable-network-policy --write-kubeconfig-mode 644" sh -

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
kubectl get nodes        # NotReady is EXPECTED — no CNI yet
```

## Step 6 — Cilium

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm repo add cilium https://helm.cilium.io/ && helm repo update

helm install cilium cilium/cilium --version 1.16.5 -n kube-system \
  --set operator.replicas=1 \
  --set 'ipam.operator.clusterPoolIPv4PodCIDRList={10.42.0.0/16}' \
  --set k8sServiceHost=127.0.0.1 --set k8sServicePort=6443 \
  --set hubble.enabled=true --set hubble.relay.enabled=true --set hubble.ui.enabled=false

kubectl -n kube-system rollout status ds/cilium --timeout=300s
kubectl get nodes        # Ready now
```

Note `clusterPoolIPv4PodCIDRList` (a list). The older `clusterPoolIPv4PodCIDR` was **removed**
and fails the template render.

## Step 7 — sealed-secrets

The Helm repo `https://bitnami-labs.github.io/sealed-secrets` **404s**. Use the release
manifest, and match the CLI version to the controller:

```bash
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.27.1/controller.yaml
kubectl -n kube-system rollout status deploy/sealed-secrets-controller --timeout=180s

curl -fsSL https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.27.1/kubeseal-0.27.1-linux-amd64.tar.gz \
  | tar xz -C /tmp kubeseal && install -m755 /tmp/kubeseal /usr/local/bin/kubeseal
```

**Back the controller key up immediately.** Losing it makes every committed `.sealed.yaml`
permanently undecryptable — recovery is reissuing every credential by hand.
See [`docs/04-SECRETS.md`](../docs/04-SECRETS.md) §5.

```bash
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml \
  > sealed-secrets-key-$(date +%F).yaml
chmod 600 sealed-secrets-key-$(date +%F).yaml
# then encrypt it to a key that does NOT live in this cluster, and shred the plaintext
```

## Step 8 — Secrets

```bash
kubectl apply -f manifests/00-namespace/namespace.yaml

# Build the Secret from real values, apply the split-brain guards from
# 01-prerequisites.md §4, then seal. Nothing plaintext is written to disk that
# is not shredded in the same step.
kubectl -n backbone create secret generic backbone-secrets \
  --from-literal=OPENROUTER_API_KEY="..." \
  --from-literal=TELEGRAM_BOT_TOKEN="<the SECOND bot>" \
  --from-literal=WEBHOOK_SECRET="$(openssl rand -hex 32)" \
  ... \
  --dry-run=client -o yaml > /tmp/plain.yaml

kubeseal --format yaml --controller-name=sealed-secrets-controller \
  --controller-namespace=kube-system < /tmp/plain.yaml > backbone-secrets.sealed.yaml
shred -u /tmp/plain.yaml

kubectl apply -f backbone-secrets.sealed.yaml
kubectl -n backbone get secret backbone-secrets     # controller decrypted it
```

The sealed file **is safe to commit** — that is the point.

**Key naming:** the gateway uses `envFrom.secretRef`, so its keys become env vars verbatim and
must be `UPPERCASE`. notify-mcp maps three keys explicitly via `secretKeyRef` and expects
`lowercase`. Include both.

## Step 9 — Deploy

```bash
helm install backbone charts/backbone -n backbone \
  --set image.registry=docker.io --set image.repository=backbone \
  --set gateway.image.name=hermes-gateway --set gateway.image.tag=dev \
  --set notifyMcp.image.name=notify-mcp --set notifyMcp.image.tag=dev \
  --set image.pullPolicy=Never \
  --set ingress.enabled=false \
  --set gateway.dashboard.enabled=false \
  --set networkPolicy.enabled=true

kubectl -n backbone get pods -w
```

> **`--reuse-values` will bite you.** On upgrade it reuses the *previous release's* values and
> ignores new chart defaults, so any newly-added key renders as empty and its resources never
> appear. Pass the full `--set` list, or use `--reset-then-reuse-values`.

Expected steady state:

```
backbone-gateway-…      1/1 Running   0 restarts
backbone-notify-mcp-…   1/1 Running   ×2
backbone-ntfy-0         1/1 Running
```

## Step 10 — Verify

```bash
# 1. NEGATIVE — a pod with no allow-list entry must be REFUSED.
#    The probe must itself satisfy the `restricted` Pod Security Standard or the
#    API server rejects it before the network policy is ever exercised.
kubectl -n backbone run probe --rm -i --restart=Never --image=curlimages/curl:8.10.1 \
  --overrides='{"spec":{"securityContext":{"runAsNonRoot":true,"runAsUser":65532,
    "seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"probe",
    "image":"curlimages/curl:8.10.1","securityContext":{"allowPrivilegeEscalation":false,
    "capabilities":{"drop":["ALL"]}},"command":["sh","-c",
    "curl -m 6 http://backbone-ntfy || echo REFUSED"]}]}}'
# expect: curl 28 timeout -> REFUSED

# 2. POSITIVE — an allow-listed flow must still work. Do NOT skip this:
#    "refused" and "broken" are the same observation.
kubectl -n backbone exec deploy/backbone-gateway -c gateway -- python -c "
import urllib.request
print(urllib.request.urlopen('http://backbone-notify-mcp.backbone.svc.cluster.local/healthz', timeout=8).status)"
# expect: 200

# 3. End to end, through both policies.
kubectl -n backbone exec deploy/backbone-gateway -c gateway -- python -c "
import urllib.request, json
req=urllib.request.Request('http://backbone-notify-mcp.backbone.svc.cluster.local/mcp',
  method='POST', headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'},
  data=json.dumps({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'notify',
    'arguments':{'text':'smoke test'}}}).encode())
print(urllib.request.urlopen(req, timeout=25).read().decode()[:200])"
# expect: ok:true, ntfy status 200

# 4. Audit chain integrity.
POD=$(kubectl -n backbone get pod -l app.kubernetes.io/name=notify-mcp -o jsonpath='{.items[0].metadata.name}')
kubectl -n backbone exec "$POD" -- /nodejs/bin/node -e "
const {verifyChain}=require('/app/dist/audit.js'), fs=require('fs'), d='/var/lib/backbone/audit';
for(const f of fs.readdirSync(d)){const r=verifyChain(fs.readFileSync(d+'/'+f,'utf8'));
  console.log(f, 'lines='+r.lines, 'VALID='+r.valid);}"
# expect: VALID=true per replica
```

ntfy ships `auth-default-access: deny-all` by design. Grant publish explicitly or every
delivery returns **403** — which is the authorization layer working, not a network fault:

```bash
kubectl -n backbone exec backbone-ntfy-0 -- ntfy access '*' '<topic>' write-only
kubectl -n backbone delete pod backbone-ntfy-0     # reload auth
```

## Step 12 — Keycloak + oauth2-proxy (SSO)

Keycloak lives in its own `identity` namespace: the IdP is cluster infrastructure, and
uninstalling Backbone should not take the realm with it.

```bash
kubectl apply -f platform/keycloak/keycloak.yaml
kubectl -n identity create secret generic keycloak-secrets \
  --from-literal=admin-password="$(openssl rand -hex 20)" \
  --from-literal=db-password="$(openssl rand -hex 20)"
kubectl -n identity rollout status deploy/keycloak --timeout=420s   # JVM + schema migration
```

Bootstrap the realm, client and user. Keycloak's image has **no curl**, so use `kcadm.sh`:

```bash
KC=$(kubectl -n identity get pod -l app.kubernetes.io/name=keycloak -o jsonpath='{.items[0].metadata.name}')
PW=$(kubectl -n identity get secret keycloak-secrets -o jsonpath='{.data.admin-password}' | base64 -d)
k(){ kubectl -n identity exec "$KC" -- /opt/keycloak/bin/kcadm.sh "$@"; }

k config credentials --server http://localhost:8080 --realm master --user admin --password "$PW"
k create realms -s realm=backbone -s enabled=true
k create clients -r backbone \
  -s clientId=backbone-dashboard -s enabled=true -s protocol=openid-connect \
  -s publicClient=false -s standardFlowEnabled=true \
  -s "secret=$(openssl rand -hex 24)" \
  -s 'redirectUris=["http://127.0.0.1:4180/oauth2/callback","https://*/oauth2/callback"]'
k create users -r backbone -s username=<you> -s enabled=true \
  -s email=<you@example.com> -s emailVerified=true
k set-password -r backbone --username <you> --new-password '<password>'

# retrieve the client secret you just set
CID=$(k get clients -r backbone -q clientId=backbone-dashboard --fields id --format csv --noquotes | tr -d '\r')
SECRET=$(k get "clients/$CID/client-secret" -r backbone | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"])')
```

oauth2-proxy runs as a **sidecar in the gateway pod** — the dashboard binds pod-loopback, so the
sidecar is structurally the only path to it:

```bash
kubectl -n backbone create secret generic oauth2-proxy-secrets \
  --from-literal=client-secret="$SECRET" \
  --from-literal=cookie-secret="$(openssl rand -base64 32 | head -c 32)"   # exactly 32 bytes

helm upgrade backbone charts/backbone -n backbone --reuse-values \
  --set sso.enabled=true \
  --set sso.issuerUrl=http://keycloak.identity.svc.cluster.local:8080/realms/backbone \
  --set sso.redirectUrl=http://127.0.0.1:4180/oauth2/callback
```

> **Three things will bite here, in this order.** The sidecar cannot reach Keycloak until the
> egress rule exists (`sso.enabled` adds it, but only on the *next* upgrade). `--redirect-url`
> must be set explicitly or oauth2-proxy derives one nothing has registered. And with
> `--cookie-secure=true` on a plain-http listener the callback fails at
> `CSRF cookie '_oauth2_proxy_csrf' was not found` — which is the control working.
> Full detail in [`03-failure-modes.md`](./03-failure-modes.md) F11–F13.

## Step 13 — Make the scheduled workflows actually run

**The job table restores without the machinery to execute it.** Expect every job to fail while
the scheduler reports itself perfectly healthy.

```bash
# 1. the job scripts are NOT part of the state snapshot
tar czf scripts.tgz --exclude=__pycache__ --exclude='*.log' -C ~/.hermes scripts/
kubectl cp scripts.tgz backbone/$POD:/home/hermes/.hermes/scripts.tgz -c gateway
kubectl -n backbone exec $POD -c gateway -- sh -c 'cd /home/hermes/.hermes && tar xzf scripts.tgz && rm scripts.tgz'
```

Scan that bundle for credentials first. The three internal memory jobs make zero external calls;
anything touching Google or a backup repo should stay on the source system.

```bash
# 2. the venv shim (the initContainer does this automatically -- see F14)
# 3. the memory plugin's deps are baked into the image: sqlite-vec, numpy, networkx

# 4. trigger a run and READ THE OUTPUT FILE, not the exit code
kubectl -n backbone exec deploy/backbone-gateway -c gateway -- hermes cron run memory-feedback
kubectl -n backbone exec deploy/backbone-gateway -c gateway -- sh -c \
  'cat "$(ls -t /home/hermes/.hermes/cron/output/*/* | head -1)"'
```

Expect `Ran now: succeeded.` and real work in the log — trust demotions with fact IDs, not an
empty run.

**Decide which jobs run here.** The rule is *a workflow runs on exactly one side*. Disable
anything with an external side effect on whichever side is not authoritative:

```bash
kubectl -n backbone scale deploy/backbone-gateway --replicas=0   # never edit under a live scheduler
# ...edit cron/jobs.json via a helper pod, set enabled=false...
kubectl -n backbone scale deploy/backbone-gateway --replicas=1
```

## Step 14 — Monitoring

```bash
kubectl create namespace monitoring
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts && helm repo update
helm upgrade --install kps prometheus-community/kube-prometheus-stack -n monitoring \
  --set grafana.adminPassword="$(openssl rand -hex 16)" \
  --set grafana.persistence.enabled=false \
  --set prometheus.prometheusSpec.retention=7d \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false \
  --set alertmanager.enabled=false --wait --timeout 15m

helm upgrade backbone charts/backbone -n backbone --reuse-values \
  --set monitoring.serviceMonitor.enabled=true \
  --set monitoring.prometheusRule.enabled=true \
  --set monitoring.namespace=monitoring \
  --set exporter.enabled=true
```

Both `…SelectorNilUsesHelmValues=false` flags matter: without them the operator only picks up
ServiceMonitors and rules carrying its own release label, and yours are silently ignored.

Import the dashboard, resolving the datasource placeholder:

```bash
kubectl -n monitoring port-forward svc/kps-grafana 3000:80 &
DSUID=$(curl -sS -u admin:$PW http://127.0.0.1:3000/api/datasources | jq -r '.[]|select(.type=="prometheus")|.uid')
python3 -c "
import json,sys
d=json.load(open('observability/grafana-dashboard.json')); d.pop('__inputs',None)
d=json.loads(json.dumps(d).replace('\${DS_PROMETHEUS}','$DSUID'))
d['templating']['list']=[t for t in d['templating']['list'] if t.get('type')!='datasource']
d.pop('id',None); d['uid']='backbone-k8s'
print(json.dumps({'dashboard':d,'overwrite':True}))" > dash.json
curl -sS -u admin:$PW -H 'Content-Type: application/json' -X POST \
  http://127.0.0.1:3000/api/dashboards/db -d @dash.json
```

**Verify by querying each metric by name**, not by looking at the dashboard. A blank panel and a
healthy-idle panel are identical:

```bash
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090:9090 &
q(){ curl -sS --get --data-urlencode "query=$1" http://127.0.0.1:9090/api/v1/query | jq -r '.data.result[0].value[1] // "NO DATA"'; }
q 'sum(backbone_cost_usd_total) / clamp_min(sum(backbone_sessions_total),1)'   # cost per task
q 'backbone_workflow_runs_total{workflow="memory-feedback"}'                    # NOT job= -- reserved
q 'backbone_recall_latency_seconds_sum / backbone_recall_latency_seconds_count'
curl -sS 'http://127.0.0.1:9090/api/v1/targets?state=active' | jq -r '.data.activeTargets[]|select(.labels.job|test("backbone"))|"\(.labels.job) \(.health)"'
```

## Step 15 — Capture evidence

Especially if the cluster is temporary. An uncaptured deployment that has been destroyed is
indistinguishable from one that never happened.

```bash
D=evidence/$(date +%F) && mkdir -p $D
kubectl -n backbone get all,pvc,networkpolicy,cronjob -o yaml > $D/all-resources.yaml
kubectl -n backbone get pods,pvc,networkpolicy -o wide            > $D/cluster-state.txt
kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg endpoint list > $D/cilium-endpoints.txt
# plus the negative/positive probe output and a sample of the audit stream
```

**Scrub IPs before committing** if the repo is public.

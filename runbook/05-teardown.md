# 05 — Teardown

For a cluster that was stood up to validate a migration rather than to run forever. Written
against the 2026-07-25/26 deployment.

**Do these in order. Step 1 is the one people skip and cannot undo.**

---

## 1. Capture evidence — before anything else

After teardown this is all that remains. An uncaptured deployment that has been destroyed is
indistinguishable from one that never happened.

```bash
D=evidence/$(date +%F) && mkdir -p $D
kubectl get pods -A -o wide                                    > $D/FINAL-STATE.txt
kubectl -n backbone get all,pvc,networkpolicy,cronjob -o yaml  > $D/all-resources.yaml
helm list -A                                                  >> $D/FINAL-STATE.txt
kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg endpoint list > $D/cilium-endpoints.txt

# the metrics, through Prometheus rather than the exporter
kubectl -n monitoring port-forward svc/kps-kube-prometheus-stack-prometheus 9090:9090 &
curl -sS --get --data-urlencode 'query=sum(backbone_cost_usd_total)/clamp_min(sum(backbone_sessions_total),1)' \
  http://127.0.0.1:9090/api/v1/query | jq .

# the audit chain, verified in-cluster
POD=$(kubectl -n backbone get pod -l app.kubernetes.io/name=notify-mcp -o jsonpath='{.items[0].metadata.name}')
kubectl -n backbone exec "$POD" -- /nodejs/bin/node -e "
const {verifyChain}=require('/app/dist/audit.js'), fs=require('fs'), d='/var/lib/backbone/audit';
for(const f of fs.readdirSync(d)) console.log(f, JSON.stringify(verifyChain(fs.readFileSync(d+'/'+f,'utf8'))));"
```

**Scrub before committing** if the repo is public:

```bash
grep -rl '<your-ip>\|<your-tailnet>' evidence/ | xargs sed -i \
  -e 's/<your-ip>/<droplet-ip>/g' -e 's/<your-tailnet>/100.x.x.x/g'
```

## 2. Preserve the sealed-secrets controller key

Without it **every committed `.sealed.yaml` becomes permanently undecryptable ciphertext.** They
stay in Git, still look fine, and are worthless. Recovery is reissuing every credential by
hand — roughly two to four hours, most of it in browser consent flows.
[`docs/04-SECRETS.md`](../docs/04-SECRETS.md) §5.

```bash
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml \
  > sealed-secrets-key-$(date +%F).yaml
age -r "$(cat ~/.config/age/backbone-recipient.txt)" \
  sealed-secrets-key-$(date +%F).yaml > sealed-secrets-key-$(date +%F).yaml.age
shred -u sealed-secrets-key-$(date +%F).yaml
```

The age key **must not live in the cluster** it recovers, and must not live only on one laptop.
Two copies, two locations, neither of them the cluster.

## 3. Decide whether the cluster's state is authoritative

If anything ran here that did not run on the source system, this volume holds the only copy.

```bash
kubectl -n backbone scale deploy/backbone-gateway --replicas=0   # single writer, stop it first
kubectl -n backbone run export --rm -it --image=<gateway-image> \
  --overrides='{...mount backbone-gateway-state...}' -- \
  tar cz -C /home/hermes/.hermes . > backbone-state-$(date +%F).tgz
```

On the 2026-07-25 deployment it was **not** authoritative: external workflows stayed on the
source droplet, and the only cluster-side writes were `memory-feedback`'s trust demotions
against a *copy*. Discarded deliberately, and recorded here so it was a decision.

## 4. Revoke what was created for the migration

Easy to forget, and each is a live credential:

| | |
|---|---|
| Second Telegram bot | BotFather → `/deletebot` |
| Tailscale node | admin console → remove `backbone-k8s` |
| Tailscale auth key | admin console → revoke, if reusable |
| Keycloak realm | dies with the cluster; nothing external references it |
| SSH keypair | `~/.ssh/backbone_k8s*` — delete if it was migration-only |
| ntfy topic | rotate if it was shared with the source system |

## 5. Fix the README before the box is gone

**A torn-down cluster whose README claims continuous operation is worse than never having built
it.** The lifecycle row must say what actually happened:

> **Lifecycle** — `agent-fleet-on-eks`: stood up and torn down per session.
> `backbone-on-k8s`: migrated and validated end to end on 2026-07-25/26, then torn down for
> cost control. Reproducible from `runbook/` in ~25 minutes. Evidence in `evidence/`.

That is a defensible position — cost discipline plus reproducibility. An inaccurate one is not.

Check for anything else that assumes the cluster is up:

```bash
grep -rniE 'currently running|is running on|live at|since 2026' README.md docs/*.md
```

## 6. Destroy

```bash
/usr/local/bin/k3s-uninstall.sh     # optional; destroying the droplet is enough
```

Then delete the droplet. **Billing is hourly** — destroying stops it. Deleting is not the same
as powering off: a powered-off droplet still bills for storage.

## 7. What must survive

| | Why |
|---|---|
| `evidence/<date>/` | The only proof the deployment existed |
| The sealed-secrets controller key, encrypted | Otherwise every `.sealed.yaml` in Git is dead ciphertext |
| `docs/OPERATIONS.md` | 14 incidents — the most valuable output of the whole exercise |
| `runbook/` | What makes "torn down" defensible rather than an excuse |
| `patches/EXPECTED-SHA256` | Lets a future rebuild prove it still reproduces the source system |

## 8. Rebuilding later

Everything needed is in the repo. `runbook/02-install.md` is the procedure, ~25 minutes knowing
what is in `03-failure-modes.md`. The two things it cannot supply:

- **real credentials** — the sealed secrets decrypt only with the controller key from §2
- **the state bundle** — re-snapshot from the source with SQLite's online `.backup`, never `cp`

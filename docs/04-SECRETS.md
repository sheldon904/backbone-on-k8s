# 04 — Secrets: sealed-secrets, and the day the key is gone

The brief calls for sealed-secrets, no plaintext in Git, and documentation of key backup and
the disaster case. §5 is the part that matters.

---

## 1. What we are moving away from

From [`00-CURRENT-STATE.md §8`](./00-CURRENT-STATE.md):

- `~/.hermes/.env` — 38 variables, plaintext, mode 0600, loaded by `EnvironmentFile=`.
- `~/.hermes/config.yaml` — **contains credentials inline**: `mcp_servers.vapi.env.VAPI_TOKEN`
  and `platforms.webhook.extra.secret` are literal values in the YAML.
- `/etc/ntfy/server.yml` — `upstream-access-token` in plaintext.
- Five separate JSON credential files: `auth.json`, `google_token.json`,
  `google_client_secret.json`, `calendar-sync/google_token_personal.json`,
  `ga4-service-account.json`.

The security property today is *filesystem permissions on a single-tenant box*. That is not
nothing, but it means every secret is one `cat` away for anything running as `backbone` — which
includes the agent itself, which has a terminal toolset.

## 2. Why sealed-secrets and not the alternatives

| Option | Why not |
|---|---|
| **AWS Secrets Manager + CSI driver** | What `agent-fleet-on-eks` does. Requires a cloud secret store and an IAM identity for the cluster. This is self-managed k3s on a cheap VM; there is no IRSA to bind to. Different substrate, different correct answer |
| **HashiCorp Vault** | The right answer at scale, and unjustifiable here. Vault needs its own HA storage, unseal key ceremony, and operational attention — more moving parts than the workload it protects |
| **SOPS + age** | Genuinely close. Encrypts files in Git, decrypts at deploy time. The reason against: decryption happens on the *deploying machine*, so the private key has to live wherever CI runs. Sealed-secrets decrypts **in the cluster**, so no key ever leaves it |
| **Plain Secrets, applied by hand** | What Phase 2 does as a bootstrap. Works, but nothing is in Git, so the cluster cannot be reconstructed from the repo |

**Chosen: sealed-secrets.** One controller, one key pair, encrypted manifests that are safe to
commit to a public repository.

## 3. The config.yaml split

`config.yaml` cannot become a ConfigMap, because it is configuration *with credentials baked in*.
The split is:

| Goes to | What |
|---|---|
| **ConfigMap** `backbone-config` | model routing, timeouts, turn limits, ntfy URL, notify-mcp URL, timezone |
| **SealedSecret** `backbone-secrets` | every API key, bot token, webhook secret, OAuth client secret |
| **Assembled at startup** | the final `config.yaml`, built from both |

That last row is the part that is **not implemented**. hermes-agent reads a single
`config.yaml`; something has to compose it from a ConfigMap and a Secret at container start —
an init container with `envsubst`, or a startup wrapper. This repo does not yet have it. Tracked
as [`VALIDATION.md`](../VALIDATION.md) row C14, and it is a real gap, not a detail.

## 4. Workflow

```bash
# Install the controller (once per cluster).
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system

# Create the Secret locally -- never written to disk, never in shell history.
kubectl -n backbone create secret generic backbone-secrets \
  --from-literal=openrouter_api_key="$(read -rs -p 'openrouter: ' v && echo "$v")" \
  --from-literal=webhook_secret="$(openssl rand -hex 32)" \
  --dry-run=client -o yaml > /tmp/plain.yaml

# Seal it. The output is encrypted to THIS cluster's public key and is safe to commit.
kubeseal --format yaml --controller-namespace kube-system < /tmp/plain.yaml \
  > manifests/10-config/backbone-secrets.sealed.yaml
shred -u /tmp/plain.yaml

kubectl apply -f manifests/10-config/backbone-secrets.sealed.yaml
```

`.gitignore` excludes `*.plain.yaml` and `*.plain.json` so the intermediate cannot be committed
by reflex. `scripts/validate.sh` additionally fails the build if anything resembling a real
credential appears in a non-sealed manifest.

### Scope

A SealedSecret is encrypted to a **namespace and name** by default. Renaming it, or applying it
to a different namespace, fails to decrypt. That is a feature — it stops a sealed secret being
lifted into a namespace the attacker controls — and it is a papercut when renaming a release.
`--scope namespace-wide` relaxes the name binding; `--scope cluster-wide` relaxes both. **Use
the default (strict) unless there is a specific reason**, and record the reason.

## 5. The disaster case: the controller key is lost

This is the section that exists because it is usually missing.

**The failure.** The sealed-secrets controller generates an RSA key pair on first start and
stores the private key in a Secret in `kube-system`, labelled
`sealedsecrets.bitnami.com/sealed-secrets-key`. If the cluster is rebuilt, or that Secret is
deleted, or etcd is lost, **the private key is gone**. Every `.sealed.yaml` in this repository
becomes permanently undecryptable ciphertext.

**What that means concretely.** Not "restore from backup". The encrypted files are still in
Git, still look fine, and are worthless. Recovery is: obtain every original credential again,
from its issuer, by hand.

**Blast radius, from the Phase 0 inventory:**

| Credential | How it is recovered |
|---|---|
| `OPENROUTER_API_KEY` | revoke and reissue in the OpenRouter dashboard |
| `TELEGRAM_BOT_TOKEN` | `/revoke` then `/token` with BotFather |
| `VAPI_TOKEN` | reissue in Vapi |
| `PHOTON_PROJECT_SECRET` | reissue in Photon |
| `WEBHOOK_SECRET`, `PHOTON_WEBHOOK_SECRET` | regenerate, then **update the sender** — Vapi and Photon each need reconfiguring, and until both sides match, inbound messages are silently rejected |
| `google_token.json`, `google_client_secret.json` | re-run the OAuth consent flow, interactively, per account. There are two accounts |
| `ga4-service-account.json` | regenerate the key in Google Cloud IAM |
| `ntfy` upstream token | reissue at ntfy.sh |
| `BACKBONE_NTFY_TOPIC` | pick a new one — and re-pair the iOS Shortcut on the phone |

Realistically **two to four hours**, most of it in browser consent flows, plus a window where
inbound webhooks fail in a way that looks like a bug rather than an auth failure.

### Backing the key up

```bash
# Export every controller private key. THIS FILE IS AS SENSITIVE AS EVERY SECRET
# IT PROTECTS, COMBINED.
kubectl -n kube-system get secret \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml \
  > sealed-secrets-key-$(date +%F).yaml

# Encrypt it to something whose key is NOT in the cluster, then destroy the plaintext.
age -r "$(cat ~/.config/age/backbone-recipient.txt)" \
  sealed-secrets-key-$(date +%F).yaml > sealed-secrets-key-$(date +%F).yaml.age
shred -u sealed-secrets-key-$(date +%F).yaml
```

Restore into a fresh cluster **before** the controller first starts, or it will generate a new
key pair and ignore the old one:

```bash
age -d -i ~/.config/age/backbone-identity.txt sealed-secrets-key-2026-07-25.yaml.age \
  | kubectl apply -f -
kubectl -n kube-system delete pod -l name=sealed-secrets-controller   # pick up the restored key
```

### The circularity, stated

The backup is encrypted with an age key. **That key must not live in the cluster**, or the
disaster that loses the cluster loses the recovery path too. It also must not live only on the
laptop, or a lost laptop is the same disaster. Two copies, two locations, neither of them the
cluster — a password manager and an offline copy is the minimum honest answer.

**Key rotation is not implemented.** The controller supports it (it keeps old keys for
decryption and seals new secrets with the newest), and nothing in this repo drives it. Tracked
as an open item rather than described as if it were done.

## 6. What is still plaintext after all this

Being honest about the residue:

1. **Secrets are env vars inside the container.** Sealed-secrets protects them at rest in Git
   and in etcd (if etcd encryption is on — *k3s does not enable it by default*). Once mounted,
   they are readable in `/proc/<pid>/environ` by anything in that container. The agent has a
   terminal toolset. This is not solved here.
2. **etcd encryption at rest is off** on a default k3s install. `--secrets-encryption` enables
   it and is a cluster-bootstrap flag, out of scope for the chart but in scope for the runbook.
3. **The JSON credential files** would be better mounted as files with mode `0400` than passed
   as env vars. The chart currently does env vars. Flagged.
4. **`helm get values` shows what was passed.** Since this chart never templates secret values,
   there is nothing sensitive there — which is the reason for that design rule in `values.yaml`.

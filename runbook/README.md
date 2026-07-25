# Runbook

Deployment procedure for `backbone-on-k8s`, written **from an install that actually happened**
on 2026-07-25, not from intent. Every command here was run; every failure in
[`03-failure-modes.md`](./03-failure-modes.md) is one that occurred, in the order it occurred.

| Document | What it covers |
|---|---|
| [`01-prerequisites.md`](./01-prerequisites.md) | Host sizing, why 8 GB, why Cilium instead of the k3s default, what you must have before starting |
| [`02-install.md`](./02-install.md) | The full procedure, start to a working cluster |
| [`03-failure-modes.md`](./03-failure-modes.md) | Six failures hit during the reference install, with symptom → cause → fix |
| [`04-rollback.md`](./04-rollback.md) | Backing out, teardown, and what must survive it |

## Time and cost, measured

| | |
|---|---|
| Provision → all pods Running | **~90 minutes**, including six failures |
| Provision → all pods Running, knowing what is in here | ~25 minutes |
| Droplet cost | `s-4vcpu-8gb`, ~$0.071/hr — **~$5 for a 3-day run** |

## Reference environment

```
DigitalOcean s-4vcpu-8gb, Ubuntu 24.04 LTS, NYC1
4 vCPU · 7.9 GiB RAM · 154 GB disk · no swap
k3s      v1.36.2+k3s1   (--flannel-backend=none --disable-network-policy)
Cilium   1.16.5         (with Hubble relay)
sealed-secrets 0.27.1
Docker   29.6.2         (Phase 1 only; not needed for the k8s path)
```

## The one thing to read before anything else

**k3s ships flannel, which does not enforce NetworkPolicy.** A stock k3s install will accept
every policy in this chart and enforce none of them. If you install k3s the default way, the
Phase 4 security posture is decorative. [`01-prerequisites.md`](./01-prerequisites.md) §3.

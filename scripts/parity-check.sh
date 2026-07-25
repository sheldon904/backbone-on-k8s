#!/usr/bin/env bash
# Assert the Helm chart still agrees with the plain manifests on the properties
# that are correctness constraints rather than styling.
#
# The chart is a translation of manifests/, which came first and is kept as the
# teaching artifact. Translations drift. This catches the drift that matters --
# a `helm diff` against the manifests would catch everything, including names
# and labels that are SUPPOSED to differ, and would be ignored within a week.
#
# Each assertion below corresponds to a decision documented in docs/.

set -euo pipefail
cd "$(dirname "$0")/.."

HELM="${HELM:-helm}"
RENDER="$(mktemp)"
trap 'rm -f "$RENDER"' EXIT

"$HELM" template backbone charts/backbone > "$RENDER"

# Parse YAML properly rather than grepping. Comments in the manifests mention the
# same strings the assertions look for, and grep cannot tell a comment from a
# value -- which is how the first version of this script reported false drift.
manifest_field() {
  python3 - "$1" "$2" "$3" <<'PYEOF'
import sys, yaml
path, kind, dotted = sys.argv[1], sys.argv[2], sys.argv[3]
for doc in yaml.safe_load_all(open(path)):
    if not doc or doc.get("kind") != kind:
        continue
    cur = doc
    for part in dotted.split("."):
        cur = (cur or {}).get(part)
    print("" if cur is None else cur)
    break
PYEOF
}

# Assert the metadata service is excluded from egress, reading the NetworkPolicy
# structurally instead of counting string occurrences.
rendered_has_metadata_block() {
  python3 - "$1" <<'PYEOF'
import sys, yaml
hits = 0
for doc in yaml.safe_load_all(open(sys.argv[1])):
    if not doc or doc.get("kind") != "NetworkPolicy":
        continue
    for rule in doc.get("spec", {}).get("egress") or []:
        for to in rule.get("to") or []:
            block = to.get("ipBlock") or {}
            if any(str(e).startswith("169.254.") for e in block.get("except") or []):
                hits += 1
print(hits)
PYEOF
}

fails=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  ok    %s\n' "$desc"
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$desc" "$expected" "$actual"
    fails=$((fails + 1))
  fi
}

# --- the constraints from docs/02-STATE-TRADEOFFS.md -------------------------

# The gateway must never be scalable. If someone adds a gateway.replicas value,
# this catches it.
check "gateway replicas is 1 in manifests" \
  "1" "$(manifest_field manifests/20-workloads/hermes-gateway.yaml Deployment spec.replicas)"
check "gateway replicas is 1 in chart" \
  "1" "$(awk '/name: backbone-gateway$/,/^---/' "$RENDER" | grep -m1 'replicas:' | awk '{print $2}')"
check "no gateway.replicas value exists" \
  "0" "$(grep -cE '^\s{2}replicas:' <(awk '/^gateway:/,/^notifyMcp:/' charts/backbone/values.yaml) || true)"

# Recreate, not RollingUpdate: two writers on one SQLite file corrupts the WAL.
check "gateway strategy is Recreate in manifests" \
  "Recreate" "$(manifest_field manifests/20-workloads/hermes-gateway.yaml Deployment spec.strategy.type)"
check "gateway strategy is Recreate in chart" \
  "1" "$(awk '/name: backbone-gateway$/,/^---/' "$RENDER" | grep -c 'type: Recreate')"

# 180s drain + grace. Kubernetes' 30s default SIGKILLs mid-conversation.
check "gateway grace period is 240 in manifests" \
  "240" "$(manifest_field manifests/20-workloads/hermes-gateway.yaml Deployment spec.template.spec.terminationGracePeriodSeconds)"
check "gateway grace period is 240 in chart" \
  "240" "$(awk '/name: backbone-gateway$/,/^---/' "$RENDER" | grep -m1 'terminationGracePeriodSeconds:' | awk '{print $2}')"

# --- the constraints from docs/01-CONTAINERIZATION.md ------------------------

# Every container must satisfy the `restricted` Pod Security Standard.
containers=$(grep -c 'allowPrivilegeEscalation: false' "$RENDER")
check "every container sets allowPrivilegeEscalation false (chart)" \
  "$(grep -c 'image: ' "$RENDER")" "$containers"
check "every container drops ALL capabilities (chart)" \
  "$(grep -c 'image: ' "$RENDER")" "$(grep -c 'drop:' "$RENDER")"
check "no container runs as root (chart)" \
  "0" "$(grep -c 'runAsUser: 0' "$RENDER" || true)"
check "seccomp RuntimeDefault on every pod (chart)" \
  "$(grep -c 'kind: Deployment\|kind: StatefulSet\|kind: CronJob' "$RENDER")" \
  "$(grep -c 'type: RuntimeDefault' "$RENDER")"

# --- readiness semantics (docs/01-CONTAINERIZATION.md §2) --------------------

# /readyz must not be an alias for /healthz -- a pod with no delivery channel
# should leave the Service rather than answer 200 with {"ok":false}.
check "notify-mcp readiness uses /readyz not /healthz (manifests)" \
  "1" "$(grep -c 'path: /readyz' manifests/20-workloads/notify-mcp.yaml)"
check "notify-mcp readiness uses /readyz not /healthz (chart)" \
  "1" "$(grep -c 'path: /readyz' "$RENDER")"

# The dashboard probe must be exec. httpGet's host is dialled by the kubelet
# from the node, so 127.0.0.1 there is the node's loopback.
check "dashboard probe is exec, not httpGet with a host (chart)" \
  "0" "$(grep -c 'host: 127.0.0.1' "$RENDER" || true)"

# --- the dashboard must not be routable without SSO --------------------------

check "no dashboard Service by default (chart)" \
  "0" "$(grep -c 'name: backbone-gateway-dashboard' "$RENDER" || true)"

if "$HELM" template backbone charts/backbone --set ingress.exposeDashboard=true >/dev/null 2>&1; then
  printf '  FAIL  exposing the dashboard without SSO should be refused\n'
  fails=$((fails + 1))
else
  printf '  ok    exposing the dashboard without SSO is refused by the template\n'
fi

# --- network policy is default-deny on BOTH directions -----------------------

deny=$("$HELM" template backbone charts/backbone \
  | awk '/name: backbone-default-deny/,/^---/')
check "default-deny covers Ingress and Egress" \
  "1" "$(echo "$deny" | grep -c 'policyTypes: \[Ingress, Egress\]')"
check "default-deny selects all pods (empty podSelector)" \
  "1" "$(echo "$deny" | grep -c 'podSelector: {}')"
check "metadata endpoint 169.254.0.0/16 is in the egress except list" \
  "1" "$(rendered_has_metadata_block "$RENDER")"

# --- secrets are never templated ---------------------------------------------

check "no secret values in rendered output" \
  "0" "$("$HELM" template backbone charts/backbone | grep -c 'kind: Secret' || true)"
check "no secrets.values map in values.yaml" \
  "0" "$(grep -cE '^\s+values:' <(awk '/^secrets:/,/^ingress:/' charts/backbone/values.yaml) || true)"

echo
if [ "$fails" -eq 0 ]; then
  echo "PARITY OK — chart agrees with manifests on every asserted constraint"
  exit 0
fi
echo "PARITY FAILED — $fails constraint(s) drifted"
exit 1

#!/usr/bin/env bash
# Static validation of everything in this repo that can be checked without a
# cluster. This is what CI runs, and it is runnable locally with two static
# binaries and no daemon.
#
#   ./scripts/validate.sh
#
# Exits non-zero on the first failing stage.

set -euo pipefail

cd "$(dirname "$0")/.."

K8S_VERSION="${K8S_VERSION:-1.31.0}"
KUBECONFORM="${KUBECONFORM:-kubeconform}"
HELM="${HELM:-helm}"

# Traefik Middleware and SealedSecret are CRDs; kubeconform cannot know their
# schemas from the built-in bundle. Point it at the community CRD catalogue and
# skip what is not published there rather than passing -ignore-missing-schemas
# globally, which would silently skip typos in core resources too.
SCHEMA_LOCATIONS=(
  -schema-location default
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
)
SKIP_KINDS="Middleware,SealedSecret,ServiceMonitor,PrometheusRule,IngressRoute"

section() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

section "manifests: kubeconform (strict, k8s ${K8S_VERSION})"
"$KUBECONFORM" -strict -summary \
  -kubernetes-version "$K8S_VERSION" \
  "${SCHEMA_LOCATIONS[@]}" \
  -skip "$SKIP_KINDS" \
  manifests/

section "chart: helm lint"
"$HELM" lint charts/backbone

section "chart: helm template renders"
"$HELM" template backbone charts/backbone > /tmp/backbone-rendered.yaml
printf 'rendered %s lines\n' "$(wc -l < /tmp/backbone-rendered.yaml)"

section "chart: rendered output is valid Kubernetes"
"$HELM" template backbone charts/backbone \
  | "$KUBECONFORM" -strict -summary \
      -kubernetes-version "$K8S_VERSION" \
      "${SCHEMA_LOCATIONS[@]}" \
      -skip "$SKIP_KINDS" \
      -

section "chart: non-default values still render"
for vf in charts/backbone/ci/*.yaml; do
  [ -e "$vf" ] || continue
  printf '  %s\n' "$vf"
  "$HELM" template backbone charts/backbone -f "$vf" \
    | "$KUBECONFORM" -strict -summary \
        -kubernetes-version "$K8S_VERSION" \
        "${SCHEMA_LOCATIONS[@]}" \
        -skip "$SKIP_KINDS" \
        - > /dev/null
done

section "chart matches the plain manifests on the properties that matter"
./scripts/parity-check.sh

section "shell: syntax"
find scripts -name '*.sh' -print0 | xargs -0 -n1 bash -n
echo "ok"

section "no NUL bytes or committed secrets"
if grep -rlP '\x00' --include='*.ts' --include='*.yaml' --include='*.yml' \
     --include='*.json' --include='*.md' --include='*.sh' . 2>/dev/null; then
  echo "FAIL: NUL byte in tracked source"; exit 1
fi
# A filled-in secret template must never be committed. The example uses
# REPLACE_ME; anything else in a non-sealed Secret is a finding.
if grep -rn --include='*.yaml' -E '^\s+(password|token|api_key|secret):\s*["'"'"']?[A-Za-z0-9+/]{16,}' \
     manifests/ charts/ 2>/dev/null | grep -v REPLACE_ME | grep -v sealed; then
  echo "FAIL: what looks like a real secret is committed"; exit 1
fi
echo "ok"

printf '\n\033[1mALL STATIC CHECKS PASSED\033[0m\n'

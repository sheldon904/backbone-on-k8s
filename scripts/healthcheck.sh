#!/usr/bin/env bash
# Green/red on the containerized stack, run from the host.
#
# Deliberately a host-side script rather than container HEALTHCHECK directives:
# the notify-mcp image is distroless and has no shell to run one in. Kubernetes
# does not have this problem -- the kubelet performs httpGet probes itself --
# so this script exists for the Compose phase and for poking a cluster through
# a port-forward.
#
# Usage:
#   ./scripts/healthcheck.sh                    # against Compose defaults
#   NOTIFY_URL=http://localhost:9090 ./scripts/healthcheck.sh
#
# Default ports are 18xxx to avoid probing the live droplet -- see
# docs/OPERATIONS.md, 2026-07-25 false-positive entry.
#
# Exits 0 if every check passes, 1 otherwise.

set -uo pipefail

NOTIFY_URL="${NOTIFY_URL:-http://127.0.0.1:18080}"
NTFY_URL="${NTFY_URL:-http://127.0.0.1:18081}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18645}"
TIMEOUT="${TIMEOUT:-5}"

fails=()
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails+=("$1"); }
skip() { printf '  skip  %s\n' "$1"; }

echo "backbone-on-k8s healthcheck @ $(date -Iseconds)"

# 1. notify-mcp liveness
if curl -fsS --max-time "$TIMEOUT" -o /dev/null "${NOTIFY_URL}/healthz"; then
  pass "notify-mcp /healthz"
else
  fail "notify-mcp /healthz unreachable at ${NOTIFY_URL}"
fi

# 2. notify-mcp readiness -- 503 here means no delivery channel is configured,
#    which is a config error, not a crash. Distinguish the two.
code="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "${NOTIFY_URL}/readyz" 2>/dev/null)"
case "$code" in
  200) pass "notify-mcp /readyz ($(curl -sS --max-time "$TIMEOUT" "${NOTIFY_URL}/readyz" | sed 's/.*"reason":"\([^"]*\)".*/\1/'))" ;;
  503) fail "notify-mcp NotReady — no delivery channel configured (check BACKBONE_NTFY_TOPIC / TELEGRAM_*)" ;;
  *)   fail "notify-mcp /readyz returned '${code:-no response}'" ;;
esac

# 3. notify-mcp speaks MCP. This is the check that would have caught the
#    2026-07-25 stateless-transport bug, which /healthz happily missed.
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"healthcheck","version":"1"}}}'
if curl -fsS --max-time "$TIMEOUT" -X POST "${NOTIFY_URL}/mcp" \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d "$init" 2>/dev/null | grep -q '"serverInfo"'; then
  pass "notify-mcp MCP initialize"
else
  fail "notify-mcp did not answer MCP initialize"
fi

# 4. ...and answers a SECOND request. The bug was that request 1 succeeded and
#    every subsequent one failed, so a single-shot check proves nothing.
list='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
if curl -fsS --max-time "$TIMEOUT" -X POST "${NOTIFY_URL}/mcp" \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d "$list" 2>/dev/null | grep -q '"notify"'; then
  pass "notify-mcp tools/list on a second request"
else
  fail "notify-mcp tools/list failed — transport may be holding per-request state"
fi

# 5. metrics endpoint is scrapeable and well-formed
if curl -fsS --max-time "$TIMEOUT" "${NOTIFY_URL}/metrics" 2>/dev/null | grep -q '^# TYPE backbone_notify_total counter'; then
  pass "notify-mcp /metrics"
else
  fail "notify-mcp /metrics missing or malformed"
fi

# 6. ntfy
if curl -fsS --max-time "$TIMEOUT" "${NTFY_URL}/v1/health" 2>/dev/null | grep -q 'true'; then
  pass "ntfy /v1/health"
else
  fail "ntfy unreachable at ${NTFY_URL}"
fi

# 7. gateway. hermes-agent exposes no HTTP health endpoint on its webhook
#    listener, so there is nothing to assert a 200 on. "Something accepted a
#    connection" is NOT treated as a pass: on 2026-07-25 that reported the live
#    production gateway as the container being healthy. If the port answers but
#    cannot be attributed to this stack, say so rather than claiming ok.
gw_code="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "${GATEWAY_URL}/" 2>/dev/null)"
if [ -z "$gw_code" ] || [ "$gw_code" = "000" ]; then
  skip "hermes-gateway not reachable at ${GATEWAY_URL} (expected — the gateway image is not built)"
elif [ -n "${GATEWAY_EXPECT_CONTAINER:-}" ]; then
  pass "hermes-gateway answered HTTP ${gw_code} at ${GATEWAY_URL}"
else
  skip "something answered HTTP ${gw_code} at ${GATEWAY_URL}, but it cannot be attributed to this stack — set GATEWAY_EXPECT_CONTAINER=1 once the gateway image is running"
fi

echo
if [ "${#fails[@]}" -eq 0 ]; then
  echo "GREEN"
  exit 0
fi
echo "RED — ${#fails[@]} check(s) failed:"
for f in "${fails[@]}"; do echo "  - $f"; done
exit 1

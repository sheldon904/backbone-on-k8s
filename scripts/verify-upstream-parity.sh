#!/usr/bin/env bash
# Assert the patched upstream tree still matches what the running system has.
#
# The gateway image installs hermes-agent from a pinned tag and applies
# patches/*.patch on top. Those patches exist because the SOURCE system's
# checkout carries uncommitted local modifications -- an image built from
# pristine upstream silently loses them, and one of them is a transaction-leak
# fix whose absence produces intermittent database-wide write locks.
#
# This clones the pinned tag, applies the patches, and compares each patched
# file against EXPECTED-SHA256. It needs no access to the live host, so CI can
# run it: what it catches is a patch that stopped applying the way it used to,
# or an upstream tag that moved under us.
#
#   ./scripts/verify-upstream-parity.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${HERMES_REF:-v2026.7.1}"
REPO="${HERMES_REPO:-https://github.com/NousResearch/hermes-agent.git}"
PATCHES="$PWD/services/hermes-gateway/patches"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "== cloning $REF =="
git clone -q --depth 1 --branch "$REF" "$REPO" "$WORK/src"

echo "== applying patches =="
for p in "$PATCHES"/*.patch; do
  [ -e "$p" ] || continue
  printf '  %-46s ' "$(basename "$p")"
  git -C "$WORK/src" apply "$p" && echo "ok"
done

echo "== comparing against EXPECTED-SHA256 =="
fails=0
while read -r want file; do
  case "$want" in '#'*|'') continue ;; esac
  got="$(sha256sum "$WORK/src/$file" | cut -d' ' -f1)"
  if [ "$want" = "$got" ]; then
    printf '  ok    %s\n' "$file"
  else
    printf '  FAIL  %s\n        expected %s\n        got      %s\n' "$file" "$want" "$got"
    fails=$((fails + 1))
  fi
done < "$PATCHES/EXPECTED-SHA256"

echo
if [ "$fails" -eq 0 ]; then
  echo "UPSTREAM PARITY OK — the patched tree is byte-identical to the recorded reference"
  exit 0
fi
echo "UPSTREAM PARITY FAILED — $fails file(s) drifted"
exit 1

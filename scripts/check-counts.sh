#!/usr/bin/env bash
# Assert the numbers the docs state match the numbers that exist.
#
# Every count in this repo is hand-written prose somewhere: "14 real incidents",
# "21 panels", "38 verified locally". Prose drifts silently and a stale count in
# a document about not overstating things is a bad look. This derives each from
# the artifact and fails if they disagree.
set -euo pipefail
cd "$(dirname "$0")/.."
fails=0
chk(){ if [ "$2" = "$3" ]; then printf '  ok    %s = %s\n' "$1" "$2"
       else printf '  FAIL  %s: docs say %s, actual %s\n' "$1" "$3" "$2"; fails=$((fails+1)); fi; }

OPS=$(grep -c '^## 2026' docs/OPERATIONS.md)
FM=$(grep -c '^## F[0-9]' runbook/03-failure-modes.md)
PANELS=$(python3 -c "
import json
d=json.load(open('observability/grafana-dashboard.json'))
def w(ps):
    for p in ps:
        yield p
        yield from w(p.get('panels',[]))
print(len([p for p in w(d['panels']) if p['type']!='row']))")

chk "OPERATIONS incidents"  "$OPS"    "$(grep -oE '\*\*([0-9]+) real incidents\*\*' README.md | grep -oE '[0-9]+' | head -1)"
chk "runbook failure modes" "$FM"     "$(grep -oE '\*\*([0-9]+) failures\*\*' runbook/README.md | grep -oE '[0-9]+' | head -1)"
chk "dashboard panels"      "$PANELS" "$(grep -oE '\*\*([0-9]+) panels in [0-9]+ rows\*\*' docs/05-OBSERVABILITY.md | grep -oE '^[0-9]+|[0-9]+' | head -1)"

python3 - <<'PY'
import re, sys, pathlib
s = pathlib.Path('VALIDATION.md').read_text()
want = re.search(r'\*\*(\d+) verified locally, (\d+) in CI, (\d+) on a live cluster, (\d+) still open', s)
got = (len(re.findall(r'^\| L\d+ \|', s, re.M)),
       len(re.findall(r'^\| \*{0,2}CI\d+', s, re.M)),
       len(re.findall(r'^\| \*{0,2}K\d+', s, re.M)),
       len(re.findall(r'^\| C\d+ \|', s, re.M)))
if want and tuple(int(x) for x in want.groups()) == got:
    print(f"  ok    VALIDATION header = {got}")
else:
    print(f"  FAIL  VALIDATION header: says {want.groups() if want else None}, rows are {got}")
    sys.exit(1)
PY

echo
[ "$fails" -eq 0 ] && { echo "COUNTS OK"; exit 0; }
echo "COUNTS DRIFTED — $fails"; exit 1

#!/usr/bin/env bash
# The operator's monitoring, checked without a cluster, in seconds (deploy/k8s/monitoring/base):
#   - the alert rules' unit tests (rules/tests/), in the vmalert-tool image: series written in the test, and
#     each alert when it must fire and when it must not;
#   - the dashboards: valid JSON, unique panel IDs on a 24-column grid, every panel and query on the
#     store's data source; and every query parsed by vmalert, as a recording rule, with the alert rules.
#   hack/k8s/test-monitoring-rules.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
base="$FF_REPO_ROOT/deploy/k8s/monitoring/base"
VM_VERSION=v1.153.0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== the alert rules' unit tests"
tests=()
for file in "$base"/rules/tests/*.yaml; do tests+=("--files=/rules/tests/$(basename "$file")"); done
docker run --rm -v "$base/rules:/rules:ro" "victoriametrics/vmalert-tool:$VM_VERSION" unittest "${tests[@]}" 2>&1 \
  | grep -vE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*\binfo\b'

echo "== the dashboards"
python3 - "$base/dashboards" "$work/dashboards.yaml" <<'PY'
import json, os, sys
folder, out = sys.argv[1], sys.argv[2]
problems, rules, uids = [], [], set()
for name in sorted(os.listdir(folder)):
    with open(os.path.join(folder, name)) as f:
        board = json.load(f)
    if board.get('uid') in uids: problems.append(f'{name}: uid {board.get("uid")} used twice')
    uids.add(board.get('uid'))
    ids = [p['id'] for p in board['panels']]
    if len(ids) != len(set(ids)): problems.append(f'{name}: panel IDs repeat')
    for panel in board['panels']:
        where = f'{name} "{panel["title"]}"'
        grid = panel['gridPos']
        if grid['x'] + grid['w'] > 24: problems.append(f'{where}: wider than the grid')
        if not panel.get('description'): problems.append(f'{where}: no description')
        if panel.get('datasource', {}).get('uid') != 'victoria-metrics': problems.append(f'{where}: not on the store')
        if not panel.get('targets'): problems.append(f'{where}: no query')
        for target in panel.get('targets', []):
            if target.get('datasource', {}).get('uid') != 'victoria-metrics': problems.append(f'{where} {target["refId"]}: not on the store')
            rules.append({'record': f'dashboard:{board["uid"].replace("-", "_")}:{panel["id"]}{target["refId"]}', 'expr': target['expr']})
    print(f'  {name}: {len(board["panels"])} panels')
with open(out, 'w') as f:
    json.dump({'groups': [{'name': 'dashboards', 'rules': rules}]}, f)
if problems:
    print('\n'.join('  FAIL ' + p for p in problems)); sys.exit(1)
print(f'  {len(rules)} queries to parse')
PY

echo "== every rule and query parsed by vmalert"
docker run --rm -v "$base/rules:/rules:ro" -v "$work:/dashboards:ro" "victoriametrics/vmalert:$VM_VERSION" \
  -dryRun -rule='/rules/*.yaml' -rule=/dashboards/dashboards.yaml >"$work/dry-run.log" 2>&1 \
  || { cat "$work/dry-run.log"; echo "  FAIL vmalert refused a rule or a query" >&2; exit 1; }
grep -o 'found [0-9]* files.*' "$work/dry-run.log" | sed 's/^/  /' || true
echo "monitoring rules and dashboards: OK"

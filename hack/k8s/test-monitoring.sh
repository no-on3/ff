#!/usr/bin/env bash
# L3: the operator's monitoring on the dev cluster (hack/k8s/monitoring-up.sh installs it). It runs L4
# (hack/e2e.sh) with its backend's metrics where the cluster's store scrapes them, then checks:
#   - every target the store scrapes answers: the backend during the run, the cluster, the log pipeline, the stack;
#   - every panel of both dashboards answers with data, through Grafana's API, over the run's window;
#   - the run's own values are there: its calls by outcome, the lost one, its refusals, its alarm;
#   - vmalert has loaded every rule, each evaluated without error;
#   - once the run's backend has stopped, "FFBackendDown" fires, and its e-mail reaches Mailpit.
# The address the store scrapes (this machine's on the cluster's network, port 9464) must be free: stop a
# development backend listening there first.
#   hack/k8s/test-monitoring.sh                 (about 12 minutes: L4, then the alert's 2 minutes and its e-mail)
# Grafana runs on this machine, as in development (hack/k8s/grafana.sh): the 2 GB node has no room for it.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
kubectl -n ff-monitoring get statefulset victoria-metrics >/dev/null 2>&1 \
  || { echo "no monitoring on the cluster: run hack/k8s/monitoring-up.sh first" >&2; exit 1; }
host="$("$FF_REPO_ROOT/hack/k8s/host-address.sh")"
port="${FF_DEV_METRICS_PORT:-9464}"
if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
  echo "something already listens on $host:$port, where the store scrapes the backend: stop it first" >&2
  exit 1
fi

work="$(mktemp -d)"
pids=()
cleanup() {
  local pid
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
passed=0
fail() {
  echo "  FAIL $1" >&2
  exit 1
}
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
    passed=$((passed + 1))
  else
    fail "$1 (expected '$2', got '$3')"
  fi
}
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
# forward <variable> <service> <port>: a port-forward on a free local port; the variable gets its URL once it answers.
forward() {
  local local_port
  local_port="$(free_port)"
  kubectl -n ff-monitoring port-forward "svc/$2" "$local_port:$3" >"$work/forward-$2.log" 2>&1 &
  pids+=("$!")
  for _ in $(seq 1 30); do
    curl -s -o /dev/null "http://127.0.0.1:$local_port/" && break
    sleep 0.5
  done
  printf -v "$1" 'http://127.0.0.1:%s' "$local_port"
}
forward vm victoria-metrics 8428
forward vmalert vmalert 8880
forward mailpit mailpit 8025
grafana_auth="admin:$(cat "$FF_KUBE_DIR/grafana-admin-password")"
# value <MetricsQL>: the query's one value now, or "none".
value() { curl -s "$vm/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // "none"'; }

echo "== the stack's permissions"
# can <service account> <verb> <resource> [namespace] [subresource]: what the API server answers. A subresource is
# named apart: "nodes/proxy" would be the node named "proxy".
can() { kubectl auth can-i "$2" "$3" --as="system:serviceaccount:ff-monitoring:$1" ${4:+-n "$4"} ${5:+--subresource="$5"} 2>/dev/null || true; }
check "the store finds the platform's pods, never a tenant's" "yes yes yes no" \
  "$(can victoria-metrics list pods ff-system) $(can victoria-metrics list pods ff-logging) $(can victoria-metrics list pods ff-monitoring) $(can victoria-metrics list pods ff-t-000000000000)"
check "it reads the nodes and their kubelet's metrics; no Secret, nor the kubelet's proxy" "yes yes no no" \
  "$(can victoria-metrics list nodes) $(can victoria-metrics get nodes '' metrics) $(can victoria-metrics get secrets ff-monitoring) $(can victoria-metrics get nodes '' proxy)"
check "kube-state-metrics lists the platform's kinds everywhere, and reads no Secret nor ConfigMap" "yes yes no no" \
  "$(can kube-state-metrics list pods ff-t-000000000000) $(can kube-state-metrics list deployments ff-system) $(can kube-state-metrics list secrets ff-system) $(can kube-state-metrics list configmaps ff-system)"

echo "== the stack's network policies, from an ordinary pod"
probe_ns="ff-monitoring-probe-$RANDOM"
kubectl create namespace "$probe_ns" >/dev/null
trap 'kubectl delete namespace "$probe_ns" --wait=false >/dev/null 2>&1 || true; cleanup' EXIT
# Each address: open, or refused within 3 s; the API server answering shows that the pod's network works.
kubectl -n "$probe_ns" run probe --image=ff-runtime-nodejs:24-v3 --image-pull-policy=Never --restart=Never --command -- node -e '
const net = require("node:net");
const targets = { api: ["kubernetes.default.svc", 443], store: ["victoria-metrics.ff-monitoring.svc", 8428],
  alertmanager: ["alertmanager.ff-monitoring.svc", 9093], mailpit: ["mailpit.ff-monitoring.svc", 1025] };
Promise.all(Object.entries(targets).map(([name, [host, port]]) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (state) => { socket.destroy(); resolve(name + "=" + state); };
  socket.setTimeout(3000, () => done("refused"));
  socket.once("connect", () => done("open"));
  socket.once("error", () => done("refused"));
}))).then((states) => console.log(states.join(" ")));' >/dev/null
kubectl -n "$probe_ns" wait --for=jsonpath='{.status.phase}'=Succeeded pod/probe --timeout=120s >/dev/null || true
check "it reaches the API server, and none of the stack" "api=open store=refused alertmanager=refused mailpit=refused" \
  "$(kubectl -n "$probe_ns" logs probe 2>/dev/null | tail -1)"
kubectl delete namespace "$probe_ns" --wait=false >/dev/null

echo "== L4, its backend's metrics on $host:$port for the store"
started="$(date +%s)"
FF_E2E_METRICS_HOST="$host" FF_E2E_METRICS_PORT="$port" "$FF_REPO_ROOT/hack/e2e.sh" >"$work/l4.log" 2>&1 \
  || { tail -20 "$work/l4.log"; fail "L4 failed (its log above)"; }
ended="$(date +%s)"
check "L4 passed" true "$(grep -q 'e2e: [0-9]* checks passed' "$work/l4.log" && echo true || echo false)"
# Grafana as development runs it, on this machine (hack/k8s/grafana.sh): the cluster's own image and settings,
# its data source and the dashboards in git, on the cluster's store.
grafana_port="$(free_port)"
FF_GRAFANA_PORT="$grafana_port" "$FF_REPO_ROOT/hack/k8s/grafana.sh" >"$work/grafana.log" 2>&1 &
pids+=("$!")
for _ in $(seq 1 90); do grep -q '^Grafana:' "$work/grafana.log" && break; sleep 1; done
grep -q '^Grafana:' "$work/grafana.log" || { cat "$work/grafana.log"; fail "Grafana did not start"; }
grafana="http://127.0.0.1:$grafana_port"
# Mailpit's earlier mail, such as the backend down before the run, is not this test's.
curl -s -X DELETE "$mailpit/api/v1/messages" >/dev/null

echo "== the targets"
check "the store scraped the run's backend" true \
  "$([ "$(value "max_over_time(up{job=\"ff-backend\"}[$((ended - started + 60))s])")" = 1 ] && echo true || echo false)"
targets="$(curl -s "$vm/api/v1/query" --data-urlencode 'query=min by (job) (up{job!="ff-backend"})' | jq -r '[.data.result[] | "\(.metric.job)=\(.value[1])"] | sort | join(" ")')"
# Grafana runs on this machine in development, and the store scrapes itself without an `up` series.
check "every other target answers" "alertmanager=1 fluent-bit=1 kube-state-metrics=1 kubelet=1 victoria-logs=1 vmalert=1" "$targets"
check "and the store's own metrics are there" 1 "$(value 'count(vm_free_disk_space_bytes{job="victoria-metrics"})')"

echo "== the run's values"
window="$((ended - started + 120))s"
outcomes="$(curl -s "$vm/api/v1/query" --data-urlencode "query=max by (outcome) (max_over_time(ff_invocations_total[$window]))" \
  | jq -r '[.data.result[] | select((.value[1] | tonumber) > 0) | .metric.outcome] | sort | join(" ")')"
# Its one timeout is counted seconds before L4 kills its backend, so between two scrapes: never seen, as a
# counter that a process starts and loses between scrapes never is.
check "its calls by outcome: successes, errors, and the call it lost" true \
  "$(for outcome in error lost success; do [[ " $outcomes " == *" $outcome "* ]] || { echo "no $outcome in: $outcomes"; exit; }; done; echo true)"
check "the one call it lost, counted by the restarted backend" 1 "$(value "round(sum(max_over_time(ff_invocations_total{outcome=\"lost\"}[$window])))")"
check "its refusals: the rate limit's, and the credit's one" "true 1" \
  "$([ "$(value "sum(max_over_time(ff_invocations_refused_total{reason=\"rate_limit\"}[$window])) > 0")" != none ] && echo true || echo false) \
$(value "round(sum(max_over_time(ff_invocations_refused_total{reason=\"credit\"}[$window])))")"
check "its alarm, into ALARM once" 1 "$(value "round(sum(max_over_time(ff_alarm_state_changes_total{state=\"ALARM\"}[$window])))")"

echo "== every panel answers with data, through Grafana"
python3 - "$grafana" "$grafana_auth" "$((started - 300))000" "$(date +%s)000" <<'PY' >"$work/panels.txt" || { cat "$work/panels.txt"; fail "a panel has no data"; }
import base64, json, sys, urllib.request
grafana, auth, start, end = sys.argv[1:]
headers = {'Authorization': 'Basic ' + base64.b64encode(auth.encode()).decode(), 'Content-Type': 'application/json'}
def call(path, body=None):
    request = urllib.request.Request(grafana + path, data=json.dumps(body).encode() if body else None, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)
# What L4's run can't fill: its one cold start comes seconds before it kills its backend, so between two
# scrapes, and the store never sees it (as its one timeout).
MAY_BE_EMPTY = {('FF platform', 'Cold starts')}
empty, allowed, total = [], [], 0
for uid in ('ff-platform', 'ff-cluster'):
    board = call(f'/api/dashboards/uid/{uid}')['dashboard']
    for panel in board['panels']:
        for target in panel['targets']:
            total += 1
            answer = call('/api/ds/query', {'from': start, 'to': end, 'queries': [{
                'refId': target['refId'], 'datasource': target['datasource'], 'expr': target['expr'],
                'range': True, 'instant': False, 'intervalMs': 30000, 'maxDataPoints': 200}]})
            frames = answer['results'][target['refId']].get('frames', [])
            points = sum(1 for frame in frames for value in (frame['data']['values'][1] if len(frame['data']['values']) > 1 else []) if value is not None)
            if not points:
                where = f'{board["title"]} / {panel["title"]} / {target["refId"]}: {target["expr"]}'
                (allowed if (board['title'], panel['title']) in MAY_BE_EMPTY else empty).append(where)
print(f'{total} queries, {len(allowed)} without data as L4 runs')
for line in allowed: print('  allowed no data: ' + line)
for line in empty: print('  no data: ' + line)
sys.exit(1 if empty else 0)
PY
# As many as the dashboards in git have: Grafana shows those, and each answered with data.
check "all of both dashboards' queries, each with data but the cold starts' time" \
  "$(cat "$FF_REPO_ROOT"/deploy/k8s/monitoring/base/dashboards/*.json | jq -s '[.[].panels[].targets[]] | length') queries, 2 without data as L4 runs" \
  "$(head -1 "$work/panels.txt")"

echo "== the alert rules"
rules="$(curl -s "$vmalert/api/v1/rules")"
check "both groups loaded" "ff-backend ff-cluster" "$(jq -r '[.data.groups[].name] | sort | join(" ")' <<<"$rules")"
check "every rule evaluated without error" "0" "$(jq '[.data.groups[].rules[] | select((.lastError // "") != "" or .health != "ok")] | length' <<<"$rules")"

echo "== the backend gone: its alert, and its e-mail"
state=""
for _ in $(seq 1 60); do
  state="$(curl -s "$vmalert/api/v1/alerts" | jq -r '[.data.alerts[] | select(.name == "FFBackendDown") | .state][0] // "inactive"')"
  [ "$state" = firing ] && break
  sleep 5
done
check "FFBackendDown fires, 2 minutes after the run's backend stopped" firing "$state"
subject=""
for _ in $(seq 1 36); do
  subject="$(curl -s "$mailpit/api/v1/search" --data-urlencode 'query=FFBackendDown' -G | jq -r '[.messages[] | select(.Subject | startswith("[FIRING"))][0].Subject // ""')"
  [ -n "$subject" ] && break
  sleep 5
done
check "its e-mail reaches the operator, through Alertmanager: its group and severity in the subject" "[FIRING:1] FFBackendDown (ff-backend critical)" "$subject"
check "addressed to the operator" "operator@ff.test" \
  "$(curl -s "$mailpit/api/v1/search" --data-urlencode 'query=FFBackendDown' -G | jq -r '[.messages[] | select(.Subject | startswith("[FIRING"))][0].To[0].Address')"

echo "test-monitoring: $passed checks passed"

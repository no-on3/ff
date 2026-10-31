#!/usr/bin/env bash
# Grafana for the dev cluster's monitoring, run on this machine rather than in the cluster: its 250 MiB don't
# fit on the 2 GB node beside k3s, the log pipeline and the functions, which would then read their files from
# disk again and again. It is the cluster's Grafana otherwise: the same image, the same settings (read from
# deploy/k8s/monitoring/base/50-grafana.yaml), the same data source and dashboards, on the cluster's metrics
# store through a port-forward. It runs until Ctrl-C, then removes its container.
#   hack/k8s/grafana.sh            # http://localhost:3001, as admin, the password in hack/.kube/grafana-admin-password
# FF_GRAFANA_PORT chooses another port.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
base="$FF_REPO_ROOT/deploy/k8s/monitoring/base"
port="${FF_GRAFANA_PORT:-3001}"
name="ff-grafana-$port"

kubectl -n ff-monitoring get service victoria-metrics >/dev/null 2>&1 || { echo "no monitoring on the cluster: run hack/k8s/monitoring-up.sh first" >&2; exit 1; }
[ -s "$FF_KUBE_DIR/grafana-admin-password" ] || { echo "no $FF_KUBE_DIR/grafana-admin-password: run hack/k8s/monitoring-up.sh" >&2; exit 1; }
work="$(mktemp -d)"
pf=""
cleanup() {
  [ -n "$pf" ] && kill "$pf" 2>/dev/null
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

store_port="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
kubectl -n ff-monitoring port-forward svc/victoria-metrics "$store_port:8428" >"$work/port-forward.log" 2>&1 &
pf=$!
# The Deployment's settings, as docker's options; the password from its file, which only this user reads.
python3 - "$base/50-grafana.yaml" "$work/env" <<'PY'
import sys, yaml
deployment = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d['kind'] == 'Deployment')
env = deployment['spec']['template']['spec']['containers'][0]['env']
with open(sys.argv[2], 'w') as out:
    for var in env:
        if 'value' in var:
            out.write(f"{var['name']}={var['value']}\n")
PY
sed "s#http://victoria-metrics.ff-monitoring.svc:8428#http://127.0.0.1:$store_port#" "$base/grafana/datasources.yaml" >"$work/datasources.yaml"
cp "$FF_KUBE_DIR/grafana-admin-password" "$work/password"
docker run -d --name "$name" --user "$(id -u):$(id -g)" --network host --memory 384m --env-file "$work/env" \
  -e GF_SERVER_HTTP_ADDR=127.0.0.1 -e GF_SERVER_HTTP_PORT="$port" -e GF_SECURITY_ADMIN_PASSWORD__FILE=/run/ff/password \
  -e GF_PATHS_DATA=/tmp/grafana \
  -v "$work/password:/run/ff/password:ro" \
  -v "$work/datasources.yaml:/etc/grafana/provisioning/datasources/ff.yaml:ro" \
  -v "$base/grafana/dashboards.yaml:/etc/grafana/provisioning/dashboards/ff.yaml:ro" \
  -v "$base/dashboards:/var/lib/grafana-dashboards:ro" \
  grafana/grafana:13.2.3 >/dev/null
for _ in $(seq 1 90); do
  curl -sf "http://127.0.0.1:$port/api/health" >/dev/null && break
  docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep true >/dev/null || { docker logs --tail 20 "$name" >&2; exit 1; }
  sleep 1
done
curl -sf "http://127.0.0.1:$port/api/health" >/dev/null || { docker logs --tail 20 "$name" >&2; exit 1; }
echo "Grafana: http://localhost:$port, as admin, the password in hack/.kube/grafana-admin-password. Ctrl-C stops it."
wait "$pf"

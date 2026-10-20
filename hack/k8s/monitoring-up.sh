#!/usr/bin/env bash
# Installs the operator's monitoring on the dev cluster (deploy/k8s/monitoring/dev: VictoriaMetrics,
# kube-state-metrics, vmalert, Alertmanager, and Mailpit for the alerts' e-mails; Grafana's Deployment at no
# replica, since hack/k8s/grafana.sh runs it on this machine) and waits until it runs. Safe to re-run. It writes the two Secrets the stack needs: Alertmanager's configuration, to Mailpit,
# and Grafana's admin password, made once at random and copied to hack/.kube/grafana-admin-password. It asks
# about 200 MiB of the node, so it is not installed by default: cluster-up.sh --monitoring installs it too.
# hack/k8s/monitoring-down.sh removes it.
#   hack/k8s/monitoring-up.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
dir="$FF_REPO_ROOT/deploy/k8s/monitoring"
port="${FF_DEV_METRICS_PORT:-9464}"

kubectl get namespace ff-system >/dev/null 2>&1 || { echo "no ff-system namespace: run hack/k8s/cluster-up.sh first" >&2; exit 1; }
kubectl apply -f "$dir/base/00-namespace.yaml"
applied="$(kubectl -n ff-monitoring create secret generic alertmanager-config --from-file=alertmanager.yaml="$dir/dev/alertmanager.yaml" \
  --dry-run=client -o yaml | kubectl apply -f -)"
echo "$applied"
# Alertmanager reads its configuration at start only.
if [[ $applied == *configured* ]] && kubectl -n ff-monitoring get deployment alertmanager >/dev/null 2>&1; then
  kubectl -n ff-monitoring rollout restart deployment/alertmanager
fi
if ! kubectl -n ff-monitoring get secret grafana-admin >/dev/null 2>&1; then
  # Written to a file first, so that the password is on no command line.
  (umask 077 && head -c 18 /dev/urandom | base64 | tr -d '/+=\n' >"$FF_KUBE_DIR/grafana-admin-password")
  kubectl -n ff-monitoring create secret generic grafana-admin --from-file=password="$FF_KUBE_DIR/grafana-admin-password" >/dev/null
  echo "created the Secret ff-monitoring/grafana-admin"
elif [ ! -s "$FF_KUBE_DIR/grafana-admin-password" ]; then
  (umask 077 && kubectl -n ff-monitoring get secret grafana-admin -o jsonpath='{.data.password}' | base64 -d >"$FF_KUBE_DIR/grafana-admin-password")
fi
# The log pipeline's policies admit the metrics store (deploy/k8s/logging/40-network-policies.yaml).
if kubectl get namespace ff-logging >/dev/null 2>&1; then
  kubectl apply -f "$FF_REPO_ROOT/deploy/k8s/logging/40-network-policies.yaml"
fi
kubectl apply -k "$dir/dev"
# The backend on the host, at this machine's address on the cluster's network.
host="$("$FF_REPO_ROOT/hack/k8s/host-address.sh")"
kubectl apply -f - <<YAML
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: ff-backend-dev
  namespace: ff-monitoring
  labels:
    kubernetes.io/service-name: ff-backend-dev
    app.kubernetes.io/part-of: ff
addressType: IPv4
ports:
  - name: metrics
    port: $port
    protocol: TCP
endpoints:
  - addresses: ["$host"]
YAML
kubectl -n ff-monitoring rollout status statefulset/victoria-metrics --timeout=300s
for deployment in kube-state-metrics vmalert alertmanager mailpit; do
  kubectl -n ff-monitoring rollout status "deployment/$deployment" --timeout=300s
done
cat <<DONE
monitoring ready. The metrics store scrapes the backend at $host:$port: start it with
  FF_METRICS_HOST=$host (in BE/.env, or before npm run start:dev)
Grafana, on this machine: the 2 GB node has no room for it (its Deployment is kept at no replica):
  hack/k8s/grafana.sh                                              # http://localhost:3001, admin, hack/.kube/grafana-admin-password
The alerts' e-mails, in Mailpit:
  kubectl -n ff-monitoring port-forward svc/mailpit 8026:8025      # http://localhost:8026
DONE

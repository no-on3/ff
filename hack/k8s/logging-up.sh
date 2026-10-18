#!/usr/bin/env bash
# Installs FF's log pipeline (deploy/k8s/logging: Fluent Bit and VictoriaLogs, client-readiness plan P-42)
# on the dev cluster, and waits until it runs. Safe to re-run. The Secret holding VictoriaLogs' delete key
# is created once, with a random key, and never replaced; hack/k8s/log-store-key.sh copies it to
# hack/.kube for a development backend (P-45). hack/k8s/logging-down.sh removes everything.
#   hack/k8s/logging-up.sh        (or: hack/k8s/cluster-up.sh --logging)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

kubectl get namespace ff-system >/dev/null 2>&1 || { echo "no ff-system namespace: run hack/k8s/cluster-up.sh first" >&2; exit 1; }
if ! kubectl -n ff-system get secret victoria-logs-delete-key >/dev/null 2>&1; then
  # Written to a file first, so that the key is on no command line.
  key_file="$(mktemp)"
  trap 'rm -f "$key_file"' EXIT
  (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$key_file")
  kubectl -n ff-system create secret generic victoria-logs-delete-key --from-file=key="$key_file" >/dev/null
  echo "created the Secret ff-system/victoria-logs-delete-key"
fi
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/logging"
kubectl -n ff-system rollout status statefulset/victoria-logs --timeout=180s
kubectl -n ff-logging rollout status daemonset/fluent-bit --timeout=180s
"$FF_REPO_ROOT/hack/k8s/log-store-key.sh"
cat <<'DONE'
log pipeline ready. To query it:
  kubectl -n ff-system port-forward svc/victoria-logs 9428:9428 &
  curl -s http://127.0.0.1:9428/select/logsql/query --data-urlencode 'query={namespace="ff-t-…"} _time:5m'
DONE

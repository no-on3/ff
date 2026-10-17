#!/usr/bin/env bash
# Removes FF's log pipeline from the dev cluster: its objects, VictoriaLogs' volume (every stored line) and
# its delete key, and the collector's offsets and buffer on the node.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

kubectl delete -k "$FF_REPO_ROOT/deploy/k8s/logging" --ignore-not-found --wait=true
kubectl -n ff-system delete pvc -l app.kubernetes.io/name=victoria-logs --ignore-not-found --wait=true
kubectl -n ff-system delete secret victoria-logs-delete-key --ignore-not-found
for node in $(k3d node list --no-headers 2>/dev/null | awk -v c="k3d-$FF_CLUSTER_NAME-" 'index($1, c) == 1 && $2 != "loadbalancer" { print $1 }'); do
  docker exec "$node" rm -rf /var/lib/ff-logging
done
echo "log pipeline removed"

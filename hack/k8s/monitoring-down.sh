#!/usr/bin/env bash
# Removes the operator's monitoring from the dev cluster: its namespace with every object and the metrics
# store's volume (every stored series), its cluster-wide roles, its RoleBindings in ff-system and ff-logging,
# and the local copy of Grafana's password.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

kubectl delete -k "$FF_REPO_ROOT/deploy/k8s/monitoring/dev" --ignore-not-found --wait=true
kubectl delete namespace ff-monitoring --ignore-not-found --wait=true
rm -f "$FF_KUBE_DIR/grafana-admin-password"
echo "monitoring removed"

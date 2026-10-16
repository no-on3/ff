#!/usr/bin/env bash
# Deletes the FF dev cluster and its local credentials. Touches nothing else:
# other Docker containers, images, and volumes on the machine are left alone.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

if k3d cluster get "$FF_CLUSTER_NAME" >/dev/null 2>&1; then
  k3d cluster delete "$FF_CLUSTER_NAME"
else
  echo "cluster $FF_CLUSTER_NAME does not exist"
fi
rm -f "$KUBECONFIG" "$FF_SA_KUBECONFIG" "$FF_SA_TOKEN_FILE" "$FF_CA_FILE"

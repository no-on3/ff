#!/usr/bin/env bash
# Creates the resource-capped FF dev cluster (k3d/k3s), installs the base
# manifests (deploy/k8s/base) and mints ff-controller credentials.
# Safe to re-run: an existing cluster is reused.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# A k3s node needs ~1 GB; keep headroom for the backend and function pods.
MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
[ -x "$FF_REPO_ROOT/hack/bin/k3d" ] && [ -x "$FF_REPO_ROOT/hack/bin/kubectl" ] || "$FF_REPO_ROOT/hack/install-tools.sh"

mkdir -p "$FF_KUBE_DIR"
chmod 700 "$FF_KUBE_DIR"

if k3d cluster get "$FF_CLUSTER_NAME" >/dev/null 2>&1; then
  echo "cluster $FF_CLUSTER_NAME already exists; reusing it"
  k3d cluster start "$FF_CLUSTER_NAME" >/dev/null
else
  k3d cluster create "$FF_CLUSTER_NAME" \
    --image "$FF_K3S_IMAGE" \
    --servers 1 --agents 0 --no-lb \
    --api-port "127.0.0.1:$FF_API_PORT" \
    --servers-memory "$FF_NODE_MEMORY" \
    --k3s-arg "--disable=traefik@server:0" \
    --k3s-arg "--disable=metrics-server@server:0" \
    --kubeconfig-update-default=false \
    --kubeconfig-switch-context=false \
    --wait --timeout 180s
fi

(umask 077 && k3d kubeconfig get "$FF_CLUSTER_NAME" >"$KUBECONFIG")
kubectl wait --for=condition=Ready node --all --timeout=120s
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/base"
"$FF_REPO_ROOT/hack/k8s/mint-token.sh"
echo "cluster $FF_CLUSTER_NAME is ready (admin kubeconfig: $KUBECONFIG)"

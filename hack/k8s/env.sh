# Shared settings for the FF dev cluster scripts. Source it, don't run it:
#   source hack/k8s/env.sh && kubectl get pods -A
# Uses only repo-local tools (hack/bin) and a repo-local kubeconfig
# (hack/.kube), so ~/.kube/config is never read or modified.

# Works when sourced from bash (BASH_SOURCE) and zsh ($0 is the sourced file).
FF_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
export FF_REPO_ROOT
export PATH="$FF_REPO_ROOT/hack/bin:$PATH"

export FF_CLUSTER_NAME="${FF_CLUSTER_NAME:-ff-dev}"
export FF_K3S_IMAGE="${FF_K3S_IMAGE:-rancher/k3s:v1.37.1-k3s1}"
export FF_API_PORT="${FF_API_PORT:-6550}"
# Hard memory cap for the k3s node container (covers every pod in the cluster).
export FF_NODE_MEMORY="${FF_NODE_MEMORY:-2g}"
# kubelet deletes unused images once the image filesystem passes the high
# threshold (default 85%). On a shared, nearly full disk this removes the
# imported ff-runtime-* images, which have no registry to be re-pulled from.
# 95% leaves about the same headroom as hack/check-resources.sh enforces.
export FF_IMAGE_GC_HIGH_THRESHOLD="${FF_IMAGE_GC_HIGH_THRESHOLD:-95}"
export FF_IMAGE_GC_LOW_THRESHOLD="${FF_IMAGE_GC_LOW_THRESHOLD:-90}"

# The registry functions' code images go to (ADR 0003): hack/k8s/registry-up.sh runs it next to the cluster, on
# 127.0.0.1:$FF_REGISTRY_PORT for the backend, which pushes, and as $FF_REGISTRY_NAME:5000 for the nodes, which pull.
export FF_REGISTRY_NAME="${FF_REGISTRY_NAME:-$FF_CLUSTER_NAME-registry}"
export FF_REGISTRY_PORT="${FF_REGISTRY_PORT:-5056}"
export FF_REGISTRY_IMAGE="${FF_REGISTRY_IMAGE:-registry:3.1.2}"

export FF_KUBE_DIR="$FF_REPO_ROOT/hack/.kube"
# Admin credentials (cluster setup and debugging only).
export KUBECONFIG="$FF_KUBE_DIR/$FF_CLUSTER_NAME.kubeconfig"
# Least-privilege ff-controller credentials: what the backend uses.
export FF_SA_KUBECONFIG="$FF_KUBE_DIR/ff-controller.kubeconfig"
export FF_SA_TOKEN_FILE="$FF_KUBE_DIR/ff-controller.token"
export FF_CA_FILE="$FF_KUBE_DIR/ca.crt"
# The log store's delete key, which the backend uses for a closed account's lines (P-45): hack/k8s/log-store-key.sh writes it.
export FF_LOG_STORE_DELETE_KEY_FILE="$FF_KUBE_DIR/victoria-logs-delete-key"

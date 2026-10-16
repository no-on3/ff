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

export FF_KUBE_DIR="$FF_REPO_ROOT/hack/.kube"
# Admin credentials (cluster setup and debugging only).
export KUBECONFIG="$FF_KUBE_DIR/$FF_CLUSTER_NAME.kubeconfig"
# Least-privilege ff-controller credentials: what the backend uses.
export FF_SA_KUBECONFIG="$FF_KUBE_DIR/ff-controller.kubeconfig"
export FF_SA_TOKEN_FILE="$FF_KUBE_DIR/ff-controller.token"
export FF_CA_FILE="$FF_KUBE_DIR/ca.crt"

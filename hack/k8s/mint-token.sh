#!/usr/bin/env bash
# Mints a 24-hour token for the ff-controller ServiceAccount, extracts the API
# server CA, and writes a kubeconfig that authenticates only with that token.
# The backend uses these files, so development runs with the same
# least-privilege identity as production. Prints the K8S_* settings for BE/.env.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

umask 077
mkdir -p "$FF_KUBE_DIR"

kubectl -n ff-system create token ff-controller --duration=24h >"$FF_SA_TOKEN_FILE"
kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' |
  base64 -d >"$FF_CA_FILE"
server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"

rm -f "$FF_SA_KUBECONFIG"
kubectl config --kubeconfig="$FF_SA_KUBECONFIG" set-cluster "$FF_CLUSTER_NAME" \
  --server="$server" --certificate-authority="$FF_CA_FILE" --embed-certs=true >/dev/null
kubectl config --kubeconfig="$FF_SA_KUBECONFIG" set-credentials ff-controller \
  --token="$(cat "$FF_SA_TOKEN_FILE")" >/dev/null
kubectl config --kubeconfig="$FF_SA_KUBECONFIG" set-context ff-controller \
  --cluster="$FF_CLUSTER_NAME" --user=ff-controller >/dev/null
kubectl config --kubeconfig="$FF_SA_KUBECONFIG" use-context ff-controller >/dev/null

cat <<EOF
# ff-controller credentials (valid 24h; re-run hack/k8s/mint-token.sh to renew)
K8S_API_URL=$server
K8S_TOKEN_FILE=$FF_SA_TOKEN_FILE
K8S_CA_FILE=$FF_CA_FILE
K8S_INVOKE_MODE=proxy
EOF

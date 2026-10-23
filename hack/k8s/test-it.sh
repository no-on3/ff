#!/usr/bin/env bash
# Runs the L3 integration suites (BE: npm run test:it) against the dev cluster.
# Re-imports the runtime images first: in development they have no registry, so
# anything kubelet's image GC removed could not be pulled back. Functions' code
# goes to the development registry, which it makes sure runs.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
"$FF_REPO_ROOT/hack/k8s/load-images.sh"
# Functions' code reaches their pods as images (ADR 0003): the suites push them to the development registry.
"$FF_REPO_ROOT/hack/k8s/registry-up.sh"
# The sandboxed case runs where the gvisor RuntimeClass exists (hack/k8s/gvisor-up.sh).
if kubectl get runtimeclass gvisor >/dev/null 2>&1; then
  export K8S_IT_RUNTIME_CLASS="${K8S_IT_RUNTIME_CLASS:-gvisor}"
  echo "gvisor RuntimeClass found: the sandboxed case runs"
else
  echo "no gvisor RuntimeClass: the sandboxed case is skipped (hack/k8s/gvisor-up.sh installs it)"
fi
# The internet egress case needs the internet, which the cluster's pods reach through this machine.
if curl -s -m 5 -o /dev/null https://1.1.1.1; then
  export K8S_IT_INTERNET=1
  echo "internet reachable: the egress case runs"
else
  echo "no internet: the egress case is skipped"
fi
# Customers' database server's case runs where the development one runs (hack/k8s/data-db-up.sh), the node joined.
data_db="$(docker compose --project-directory "$FF_REPO_ROOT" -f "$FF_REPO_ROOT/docker-compose.yml" --profile data ps -q data-db 2>/dev/null || true)"
if [ -n "$data_db" ] && [ -f "$FF_REPO_ROOT/hack/.data-db/ca.crt" ]; then
  export K8S_IT_DATA_DB="${FF_DATA_DB_ADDRESS:-10.199.0.10}" K8S_IT_DATA_DB_CA="$FF_REPO_ROOT/hack/.data-db/ca.crt"
  echo "customers' database server found: its case runs"
else
  echo "no customers' database server: its case is skipped (hack/k8s/data-db-up.sh starts it)"
fi
# The log pipeline's suite runs where the pipeline is installed (hack/k8s/logging-up.sh).
if kubectl -n ff-system get statefulset victoria-logs >/dev/null 2>&1; then
  export K8S_IT_LOGGING=1
  # Its last case deletes an account's lines with the store's key (P-45).
  "$FF_REPO_ROOT/hack/k8s/log-store-key.sh" >/dev/null
  export K8S_LOG_STORE_DELETE_KEY_FILE="$FF_LOG_STORE_DELETE_KEY_FILE"
  echo "log pipeline found: its suite runs"
else
  echo "no log pipeline: its suite is skipped (hack/k8s/logging-up.sh installs it)"
fi
cd "$FF_REPO_ROOT/BE"
npm run test:it -- "$@"

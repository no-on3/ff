#!/usr/bin/env bash
# Runs the L3 integration suites (BE: npm run test:it) against the dev cluster.
# Re-imports the runtime images first: in development they have no registry, so
# anything kubelet's image GC removed could not be pulled back.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
"$FF_REPO_ROOT/hack/k8s/load-images.sh"
# The sandboxed case runs where the gvisor RuntimeClass exists (hack/k8s/gvisor-up.sh).
if kubectl get runtimeclass gvisor >/dev/null 2>&1; then
  export K8S_IT_RUNTIME_CLASS="${K8S_IT_RUNTIME_CLASS:-gvisor}"
  echo "gvisor RuntimeClass found: the sandboxed case runs"
else
  echo "no gvisor RuntimeClass: the sandboxed case is skipped (hack/k8s/gvisor-up.sh installs it)"
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

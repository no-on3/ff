#!/usr/bin/env bash
# Writes VictoriaLogs' delete key, from the Secret ff-system/victoria-logs-delete-key, to
# hack/.kube/victoria-logs-delete-key: the file a development backend reads it from
# (K8S_LOG_STORE_DELETE_KEY_FILE) to delete a closed account's log lines (client-readiness plan P-45).
# Readable by you alone, and written again each time, so that it follows the Secret.
#   hack/k8s/log-store-key.sh        (hack/k8s/logging-up.sh runs it)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# mktemp makes the file readable by its owner alone; the key never goes through a command line.
tmp="$(mktemp "$FF_KUBE_DIR/.victoria-logs-delete-key.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
kubectl -n ff-system get secret victoria-logs-delete-key -o jsonpath='{.data.key}' | base64 -d >"$tmp"
if [ ! -s "$tmp" ]; then
  echo "the Secret ff-system/victoria-logs-delete-key has no key: run hack/k8s/logging-up.sh" >&2
  exit 1
fi
mv "$tmp" "$FF_LOG_STORE_DELETE_KEY_FILE"
trap - EXIT
echo "wrote the log store's delete key to ${FF_LOG_STORE_DELETE_KEY_FILE#"$FF_REPO_ROOT"/}"

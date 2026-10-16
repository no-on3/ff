#!/usr/bin/env bash
# Imports locally built FF runtime images into the dev cluster, so no registry
# is needed. With no arguments, imports every local ff-runtime-* image.
#   hack/k8s/load-images.sh [image:tag ...]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

"$FF_REPO_ROOT/hack/check-resources.sh"

images=("$@")
if [ "${#images[@]}" -eq 0 ]; then
  mapfile -t images < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^ff-runtime-' || true)
fi
if [ "${#images[@]}" -eq 0 ]; then
  echo "no ff-runtime-* images found; build them first (e.g. runtimes/nodejs/test/container-smoke.sh)" >&2
  exit 1
fi

k3d image import "${images[@]}" --cluster "$FF_CLUSTER_NAME"
echo "imported into $FF_CLUSTER_NAME: ${images[*]}"

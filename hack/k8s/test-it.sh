#!/usr/bin/env bash
# Runs the L3 integration suites (BE: npm run test:it) against the dev cluster.
# Re-imports the runtime images first: in development they have no registry, so
# anything kubelet's image GC removed could not be pulled back.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
"$FF_REPO_ROOT/hack/k8s/load-images.sh"
cd "$FF_REPO_ROOT/BE"
npm run test:it -- "$@"

#!/usr/bin/env bash
# The cold-start benchmark (BE/scripts/cold-start-benchmark.ts) against the dev cluster: several functions
# deployed at once at a given size, each timed from its deploy to its first answer, and inside its pod.
# Re-imports the runtime images first, as test-it.sh does. Its functions go in a namespace of their own,
# deleted at the end.
#   hack/k8s/cold-start-benchmark.sh [--runtime-class gvisor] [--runtime nodejs|python] [--memory 128] [--at-once 3] [--rounds 2]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3000}" "$FF_REPO_ROOT/hack/check-resources.sh"
"$FF_REPO_ROOT/hack/k8s/load-images.sh" >/dev/null
cd "$FF_REPO_ROOT/BE"
npx ts-node scripts/cold-start-benchmark.ts "$@"

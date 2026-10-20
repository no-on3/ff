#!/usr/bin/env bash
# Prints this machine's address on the dev cluster's network: where the cluster reaches a backend running on
# the host. Set FF_METRICS_HOST to it for the metrics store (hack/k8s/monitoring-up.sh) to scrape the backend:
# it listens there only, not on every interface.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
docker network inspect "k3d-$FF_CLUSTER_NAME" --format '{{(index .IPAM.Config 0).Gateway}}'

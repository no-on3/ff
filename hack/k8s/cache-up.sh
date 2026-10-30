#!/usr/bin/env bash
# The server of customers' caches, for development (ADR 0013): docker-compose.yml's cache, built and started on the
# data network beside the database server; the cluster's node joined to that network at the lowest gateway priority,
# so that its default route stays the cluster's network; the CA of its certificate copied to hack/.cache-server/ca.crt, for
# the backend and functions' pods; and the backend's settings printed, for BE/.env.
#   hack/k8s/cache-up.sh          # prints the FF_CACHE_* lines
#   hack/k8s/cache-up.sh down     # stops it, the node leaves its network; its caches stay (… down --volumes: they go)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

node="k3d-$FF_CLUSTER_NAME-server-0"
address="${FF_CACHE_ADDRESS:-10.199.0.11}"
compose=(docker compose --project-directory "$FF_REPO_ROOT" -f "$FF_REPO_ROOT/docker-compose.yml" --profile cache)
out="$FF_REPO_ROOT/hack/.cache-server"

container() { "${compose[@]}" ps -q cache 2>/dev/null; }
network() { docker container inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$(container)"; }
joined() { docker container inspect -f '{{json .NetworkSettings.Networks}}' "$node" | grep -q "\"$(network)\""; }

case "${1:-up}" in
  up)
    "$FF_REPO_ROOT/hack/check-resources.sh"
    "${compose[@]}" up -d --wait cache
    if docker container inspect "$node" >/dev/null 2>&1; then
      joined || docker network connect --gw-priority -1 "$(network)" "$node"
      gateway="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "k3d-$FF_CLUSTER_NAME")"
      docker exec "$node" ip route show default | grep -q "via $gateway " ||
        { echo "the node's default route left the cluster's network: docker network disconnect $(network) $node" >&2; exit 1; }
    else
      echo "no cluster $FF_CLUSTER_NAME: functions can't reach the server until hack/k8s/cluster-up.sh, then this again" >&2
    fi
    mkdir -p "$out"
    docker cp -q "$(container):/var/lib/ff-cache/tls/ca.crt" "$out/ca.crt"
    cat <<EOT
# Customers' caches (hack/k8s/cache-up.sh): add to BE/.env
FF_CACHE_HOST=$address
FF_CACHE_AGENT_URL=https://$address:6390
FF_CACHE_AGENT_TOKEN=ff-cache-dev
FF_CACHE_CIDRS=$address/32
FF_CACHE_CA_FILE=$out/ca.crt
EOT
    ;;
  down)
    shift
    if [ -n "$(container)" ] && docker container inspect "$node" >/dev/null 2>&1 && joined; then
      # The node stays on the network while the database server is on it too.
      [ -n "$("${compose[@]}" --profile data ps -q data-db 2>/dev/null)" ] || docker network disconnect "$(network)" "$node"
    fi
    "${compose[@]}" rm -s -f cache >/dev/null
    if [ "${1:-}" = --volumes ]; then docker volume rm "$(basename "$FF_REPO_ROOT")_cache" >/dev/null; fi
    ;;
  *)
    echo "usage: $0 [up|down [--volumes]]" >&2
    exit 2
    ;;
esac

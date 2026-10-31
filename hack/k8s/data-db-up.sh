#!/usr/bin/env bash
# The server of customers' databases, for development (ADR 0008): docker-compose.yml's data-db, built and started; the
# cluster's node joined to its network at the lowest gateway priority, so that its default route stays the cluster's
# network (where Docker would otherwise move it, by the networks' names); the CA of its certificate copied to
# hack/.data-db/ca.crt, for the backend and functions' pods; and the backend's settings printed, for BE/.env.
#   hack/k8s/data-db-up.sh          # prints the FF_DATA_DB_* lines
#   hack/k8s/data-db-up.sh psql …   # psql in it, as its superuser, over its socket
#   hack/k8s/data-db-up.sh down     # stops it, the node leaves its network; its data stay (… down --volumes: they go)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

node="k3d-$FF_CLUSTER_NAME-server-0"
address="${FF_DATA_DB_ADDRESS:-10.199.0.10}"
compose=(docker compose --project-directory "$FF_REPO_ROOT" -f "$FF_REPO_ROOT/docker-compose.yml" --profile data)
out="$FF_REPO_ROOT/hack/.data-db"

container() { "${compose[@]}" ps -q data-db 2>/dev/null; }
network() { docker container inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$(container)"; }
joined() { docker container inspect -f '{{json .NetworkSettings.Networks}}' "$node" | grep "\"$(network)\"" >/dev/null; }

case "${1:-up}" in
  up)
    "$FF_REPO_ROOT/hack/check-resources.sh"
    "${compose[@]}" up -d --wait data-db
    if docker container inspect "$node" >/dev/null 2>&1; then
      joined || docker network connect --gw-priority -1 "$(network)" "$node"
      # The cluster's own network keeps the default route: a default route on the data network would send it all there.
      gateway="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "k3d-$FF_CLUSTER_NAME")"
      docker exec "$node" ip route show default | grep "via $gateway " >/dev/null ||
        { echo "the node's default route left the cluster's network: docker network disconnect $(network) $node" >&2; exit 1; }
    else
      echo "no cluster $FF_CLUSTER_NAME: functions can't reach the server until hack/k8s/cluster-up.sh, then this again" >&2
    fi
    mkdir -p "$out"
    docker cp -q "$(container):/var/lib/postgresql/tls/ca.crt" "$out/ca.crt"
    cat <<EOF
# Customers' databases (hack/k8s/data-db-up.sh): add to BE/.env
FF_DATA_DB_HOST=$address
FF_DATA_DB_ADMIN_PASSWORD=ff-data-admin-dev
FF_DATA_DB_CIDRS=$address/32
FF_DATA_DB_CA_FILE=$out/ca.crt
EOF
    ;;
  psql)
    shift
    "${compose[@]}" exec -T data-db psql -U postgres "$@"
    ;;
  down)
    shift
    if [ -n "$(container)" ] && docker container inspect "$node" >/dev/null 2>&1 && joined; then
      docker network disconnect "$(network)" "$node"
    fi
    "${compose[@]}" rm -s -f data-db >/dev/null
    if [ "${1:-}" = --volumes ]; then docker volume rm "$(basename "$FF_REPO_ROOT")_data_db" >/dev/null; fi
    ;;
  *)
    echo "usage: $0 [up|psql …|down [--volumes]]" >&2
    exit 2
    ;;
esac

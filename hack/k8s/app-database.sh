#!/usr/bin/env bash
# A PostgreSQL for a customer's app, which the dev cluster's functions reach as they would a
# database on the internet, until FF has its own (the roadmap's step 2). A tenant may never reach
# a private address (10/8, 172.16/12, 192.168/16 and the others the backend lists), FF's own
# network included; so the database is a container on a Docker network of its own in 198.18.0.0/15,
# the range set aside for tests (RFC 2544), which the cluster's node joins without giving it its
# default route. A function reaches it once its account's internet access is on.
#   hack/k8s/app-database.sh up      # prints DATABASE_URL, for `ff secrets set <function> DATABASE_URL`
#   hack/k8s/app-database.sh psql …  # psql in it, as its owner
#   hack/k8s/app-database.sh down    # removes it, with its data
# FF_APP_DB_NAME, FF_APP_DB_SUBNET and FF_APP_DB_ADDRESS give another one, as hack/cli-e2e.sh does.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

name="${FF_APP_DB_NAME:-ff-app-db}"
subnet="${FF_APP_DB_SUBNET:-198.18.0.0/24}"
address="${FF_APP_DB_ADDRESS:-198.18.0.10}"
image="${FF_APP_DB_IMAGE:-postgres:15-alpine}"
node="k3d-$FF_CLUSTER_NAME-server-0"

url() {
  local password
  password="$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" | sed -n 's/^POSTGRES_PASSWORD=//p')"
  echo "postgres://app:$password@$address:5432/app"
}

joined() { docker container inspect -f '{{json .NetworkSettings.Networks}}' "$node" | grep -q "\"$name\""; }

case "${1:-}" in
  up)
    docker container inspect "$node" >/dev/null 2>&1 || { echo "no cluster $FF_CLUSTER_NAME: run hack/k8s/cluster-up.sh" >&2; exit 1; }
    docker network inspect "$name" >/dev/null 2>&1 || docker network create --subnet "$subnet" "$name" >/dev/null
    if ! docker container inspect "$name" >/dev/null 2>&1; then
      password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
      docker run -d --name "$name" --network "$name" --ip "$address" --label ff.dev/role=app-database \
        -e POSTGRES_USER=app -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=app "$image" >/dev/null
    fi
    [ "$(docker container inspect -f '{{.State.Running}}' "$name")" = true ] || docker start "$name" >/dev/null
    # The node joins it as the lowest gateway priority: its default route stays its cluster's
    # network, where Docker would otherwise move it, by the networks' names (Docker 28 and later).
    joined || docker network connect --gw-priority -1 "$name" "$node"
    # Up to 90 s: a first start runs initdb, slow on a machine short of memory with a cluster and a test run on it.
    for _ in $(seq 1 180); do
      docker exec "$name" pg_isready -q -U app -d app && break
      sleep 0.5
    done
    docker exec "$name" pg_isready -q -U app -d app || { echo "$name didn't start: docker logs $name" >&2; exit 1; }
    url
    ;;
  psql)
    shift
    docker exec -i "$name" psql -U app -d app "$@"
    ;;
  down)
    if docker container inspect "$node" >/dev/null 2>&1 && docker network inspect "$name" >/dev/null 2>&1 && joined; then
      docker network disconnect "$name" "$node"
    fi
    docker rm -f -v "$name" >/dev/null 2>&1 || true
    docker network rm "$name" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: $0 up|psql …|down" >&2
    exit 2
    ;;
esac

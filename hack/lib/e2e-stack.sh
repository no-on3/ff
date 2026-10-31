# shellcheck shell=bash
# A whole FF stack for one end-to-end run, shared by hack/e2e.sh (L4) and
# hack/e2e-tenancy.sh (L5): PostgreSQL and S3 in their own compose project, the
# k3d dev cluster with the runtime images, and the built backend.
#
# Source it after hack/k8s/env.sh, with E2E_PROJECT (the compose project) and
# E2E_NAME (the name in messages and of the work directory) set, and with
# FF_PG_PORT and FF_S3_PORT exported (and FF_KEYCLOAK_PORT, FF_MAIL_SMTP_PORT and
# FF_MAIL_UI_PORT when it starts Keycloak). Then call e2e_dependencies, e2e_cluster,
# e2e_build, e2e_migrate and e2e_start_backend. On exit, it stops the backends
# it started, deletes the namespaces listed in e2e_namespaces, and removes the
# compose project with its volumes; the cluster too if e2e_teardown is true.

source "$FF_REPO_ROOT/hack/lib/checks.sh"
source "$FF_REPO_ROOT/hack/lib/evidence.sh"
source "$FF_REPO_ROOT/hack/lib/backend-build.sh"
work="$FF_REPO_ROOT/hack/.$E2E_NAME"
# With the "auth", "data", "cache", "mail" and "mail-test" profiles, so that cleaning up also removes Keycloak, Mailpit,
# the data, cache and mail servers and the mail's receiver when they ran.
compose=(docker compose -p "$E2E_PROJECT" -f "$FF_REPO_ROOT/docker-compose.yml" --profile auth --profile data --profile cache
  --profile mail --profile mail-test)
e2e_pids=()
e2e_namespaces=()
# Containers a test starts beside the compose project, such as a DNS server: removed on exit.
e2e_containers=()
# Commands that undo what a test set up beside the stack, such as an app's database: run on exit, first.
e2e_cleanups=()
e2e_teardown=false
# A run's stack kept for a look and for the next run (--keep), and a run against it (--reuse): what the kept run left
# for the next one to remove, its cleanups, backends, namespaces and containers, is written here.
e2e_keep=false
e2e_reuse=false
e2e_kept="$work/kept.sh"
mkdir -p "$work"
: >"$work/ports-given"

# The backend's settings, explicit so that BE/.env (read for any missing variable)
# can't change the test. Callers add the port and the authentication mode.
e2e_base_env=(
  NODE_ENV=development
  DB_HOST=127.0.0.1 DB_PORT="$FF_PG_PORT" DB_USERNAME=postgres DB_PASSWORD=postgres DB_NAME=serverless_platform
  FF_OBJECT_STORE_ENDPOINT=127.0.0.1 FF_OBJECT_STORE_PORT="$FF_S3_PORT" FF_OBJECT_STORE_USE_SSL=false FF_OBJECT_STORE_BUCKET=functions
  FF_OBJECT_STORE_ACCESS_KEY=ffdevaccesskey FF_OBJECT_STORE_SECRET_KEY=ffdevsecretkey-local-only
  ORCHESTRATOR=kubernetes K8S_API_URL="https://127.0.0.1:$FF_API_PORT" K8S_INVOKE_MODE=proxy
  K8S_TOKEN_FILE="$FF_SA_TOKEN_FILE" K8S_CA_FILE="$FF_CA_FILE" K8S_LOG_STORE_DELETE_KEY_FILE="$FF_LOG_STORE_DELETE_KEY_FILE"
  K8S_RUNTIME_CLASS="${K8S_RUNTIME_CLASS:-}"
  # The images this stack builds and imports, whatever a developer's BE/.env names: ConfigModule reads that file too.
  K8S_RUNTIME_IMAGE_NODEJS=ff-runtime-nodejs:24-v3 K8S_RUNTIME_IMAGE_PYTHON=ff-runtime-python:3.13-v3
  # No operator's metrics port: the development backend may hold the default one. A test that reads them gives a free port.
  FF_METRICS_PORT=0
  # Nor a function URL gateway, for the same reason: a test that calls URLs gives it a free port, and the base to match.
  FF_FUNCTION_URL_PORT=0
  # Nor buckets' S3 front door: a test that sends S3 requests gives it a free port.
  FF_STORAGE_PORT=0
  # Nor queues' SQS endpoint, for the same reason.
  FF_SQS_PORT=0
  # Nor mail's SES endpoint, for the same reason.
  FF_SES_PORT=0
  # Nor buckets' sites: a test that visits them gives a free port, and the base to match.
  FF_WEBSITE_PORT=0
  # Nor functions' own keys to buckets, nor customers' databases, caches and mail, whichever a developer's BE/.env names:
  # a test that uses them gives its own after these (the cluster's gateway; e2e_data_db's, e2e_cache's and e2e_mail's).
  FF_STORAGE_FUNCTION_ENDPOINT= FF_STORAGE_FUNCTION_CIDRS=
  FF_DATA_DB_HOST= FF_DATA_DB_ADMIN_HOST= FF_DATA_DB_ADMIN_PASSWORD= FF_DATA_DB_CIDRS= FF_DATA_DB_CA_FILE=
  FF_CACHE_HOST= FF_CACHE_AGENT_URL= FF_CACHE_AGENT_TOKEN= FF_CACHE_CIDRS= FF_CACHE_CA_FILE=
  FF_EMAIL_SMTP_HOST= FF_EMAIL_AGENT_URL= FF_EMAIL_AGENT_TOKEN= FF_EMAIL_CA_FILE=
  # Every function's code runs as a code image (ADR 0003), pushed to the cluster's registry (hack/k8s/registry-up.sh), pulled by its node.
  FF_CODE_REGISTRY="http://127.0.0.1:$FF_REGISTRY_PORT" FF_CODE_REGISTRY_PULL="$FF_REGISTRY_NAME:5000"
)

# e2e_fresh <service> [volume]: on a stack reused (--reuse), the service made anew, its volume with it, so that what
# the kept run left there, a customer's database, a cache's keys, the mail received, never reaches this run.
e2e_fresh() {
  $e2e_reuse || return 0
  "${compose[@]}" rm -sf "$1" >/dev/null 2>&1 || true
  [ -z "${2:-}" ] || docker volume rm "${E2E_PROJECT}_$2" >/dev/null 2>&1 || true
}

# e2e_up <what> <service...>: compose's `up -d --wait` of the services, its own last words in the failure when one
# doesn't start, such as Docker's "failed to bind host port 127.0.0.1:58026/tcp: address already in use", which nothing
# else says.
e2e_up() {
  local what=$1 said
  shift
  said="$("${compose[@]}" up -d --wait "$@" 2>&1)" || fail "$what did not become healthy: $(tail -n 2 <<<"$said" | tr '\n' ' ')"
}

# e2e_data_db <subnet> <address>: the server of customers' databases (ADR 0008), the compose project's own, on a Docker
# network of its own (a /24 no other run uses), which the cluster's node joins at the lowest gateway priority, so that
# functions reach it; its CA copied to the work directory. Sets e2e_data_db_env, the backend's FF_DATA_DB_* settings,
# e2e_data_db_container and e2e_data_subnet. The node leaves the network on exit.
e2e_data_db() {
  local subnet=$1 address=$2 node="k3d-$FF_CLUSTER_NAME-server-0" network
  e2e_data_subnet=$subnet
  e2e_fresh data-db data_db
  FF_DATA_DB_SUBNET="$subnet" FF_DATA_DB_ADDRESS="$address" e2e_up "the data server" data-db
  e2e_data_db_container="$("${compose[@]}" ps -q data-db)"
  network="${E2E_PROJECT}_data"
  docker network connect --gw-priority -1 "$network" "$node"
  e2e_cleanups+=("docker network disconnect $network $node")
  docker cp -q "$e2e_data_db_container:/var/lib/postgresql/tls/ca.crt" "$work/data-db-ca.crt"
  e2e_data_db_env=(FF_DATA_DB_HOST="$address" FF_DATA_DB_PORT=5432 FF_DATA_DB_ADMIN_PASSWORD=ff-data-admin-dev
    FF_DATA_DB_CIDRS="$address/32" FF_DATA_DB_CA_FILE="$work/data-db-ca.crt")
  echo "  customers' database server at $address"
}

# e2e_cache <address>: the server of customers' caches (ADR 0013), the compose project's own, at an address of the
# network e2e_data_db made, which the cluster's node has joined already; its CA copied to the work directory. Sets
# e2e_cache_env, the backend's FF_CACHE_* settings, and e2e_cache_container. Call it after e2e_data_db.
e2e_cache() {
  local address=$1
  e2e_fresh cache cache
  FF_DATA_DB_SUBNET="$e2e_data_subnet" FF_CACHE_ADDRESS="$address" e2e_up "the cache server" cache
  e2e_cache_container="$("${compose[@]}" ps -q cache)"
  docker cp -q "$e2e_cache_container:/var/lib/ff-cache/tls/ca.crt" "$work/cache-ca.crt"
  e2e_cache_env=(FF_CACHE_HOST="$address" FF_CACHE_PORTS=6400-6999 FF_CACHE_AGENT_URL="https://$address:6390"
    FF_CACHE_AGENT_TOKEN=ff-cache-dev FF_CACHE_CIDRS="$address/32" FF_CACHE_CA_FILE="$work/cache-ca.crt")
  echo "  customers' cache server at $address"
}

# e2e_mail <address> <receiver's address>: the server of customers' mail (ADR 0012), the compose project's own, at an
# address of the network e2e_data_db made, handing every message to the tests' stand-in for recipients' servers beside
# it (hack/lib/mail-receiver.mjs), which keeps them and refuses bounce-me@ addresses; the backend, on this machine, its
# only sender; its CA copied to the work directory. Sets e2e_mail_env, the backend's FF_EMAIL_* settings, and
# e2e_mail_container and e2e_mail_receiver. Call it after e2e_data_db.
e2e_mail() {
  local address=$1 receiver=$2
  e2e_fresh mail mail
  e2e_fresh mail-receiver
  "${compose[@]}" build -q mail >/dev/null 2>&1 || fail "the mail server's image did not build"
  FF_DATA_DB_SUBNET="$e2e_data_subnet" FF_MAIL_ADDRESS="$address" FF_MAIL_RECEIVER_ADDRESS="$receiver" \
    FF_MAIL_RELAY_FROM="${e2e_data_subnet%.*}.1/32" FF_MAIL_RELAYHOST="$receiver:2525" \
    e2e_up "the mail server" mail-receiver mail
  e2e_mail_container="$("${compose[@]}" ps -q mail)"
  e2e_mail_receiver="$("${compose[@]}" ps -q mail-receiver)"
  docker cp -q "$e2e_mail_container:/var/lib/ff-mail/tls/ca.crt" "$work/mail-ca.crt"
  e2e_mail_env=(FF_EMAIL_SMTP_HOST="$address" FF_EMAIL_AGENT_URL="https://$address:6391" FF_EMAIL_AGENT_TOKEN=ff-mail-dev
    FF_EMAIL_CA_FILE="$work/mail-ca.crt")
  echo "  customers' mail server at $address, its recipients' stand-in at $receiver"
}

# received <n>: the n-th message the stand-in receiver took, whole; received_envelope <n>, its envelope as JSON;
# received_count, how many it took.
received() { docker exec "$e2e_mail_receiver" cat "/tmp/received-$1.eml"; }
received_envelope() { docker exec "$e2e_mail_receiver" cat "/tmp/received-$1.json"; }
received_count() { docker exec "$e2e_mail_receiver" sh -c 'ls /tmp | grep -c "^received-.*\.eml$" || true'; }

# cache_cli <address> <command…>: valkey-cli as a customer's app connects, with the address FF gave, over TLS, the
# server's CA named; inside the server's own container, which reaches its own address. Prints the reply, or the error,
# and never fails: valkey-cli exits 1 when it can't connect, which under pipefail would fail a check that greps it.
cache_cli() {
  local url=$1
  shift
  docker exec "$e2e_cache_container" valkey-cli --no-auth-warning --tls --cacert /var/lib/ff-cache/tls/ca.crt -u "$url" "$@" 2>&1 || true
}

# data_db_psql <connection string> <sql>: psql as a customer's app connects, with the string FF gave, the server's CA
# named; inside the server's own container, which reaches its own address. Prints the rows, or fails with the error:
# under pipefail, a check that greps the error runs it as (data_db_psql … || true) | grep.
data_db_psql() {
  docker exec "$e2e_data_db_container" psql "$1&sslrootcert=/var/lib/postgresql/tls/ca.crt" -XAtc "$2" 2>&1
}

# e2e_dns <port> <directory>: a DNS server on 127.0.0.1:<port>, CoreDNS, for customers' domains: each zone file
# <zone>.db in the directory is served, read again within a second of a change (its serial must grow).
e2e_dns() {
  local port=$1 dir=$2 zone
  : >"$dir/Corefile"
  for zone in "$dir"/*.db; do
    zone="$(basename "$zone" .db)"
    printf '%s:53 {\n  file /zones/%s.db {\n    reload 1s\n  }\n}\n' "$zone" "$zone" >>"$dir/Corefile"
  done
  docker run -d --name "$E2E_PROJECT-dns" -p "127.0.0.1:$port:53/udp" -p "127.0.0.1:$port:53/tcp" -v "$dir:/zones:ro" \
    rancher/mirrored-coredns-coredns:1.14.7 -conf /zones/Corefile >/dev/null
  e2e_containers+=("$E2E_PROJECT-dns")
}

# e2e_options <argument…>: a suite's own options: --teardown deletes the cluster at the end; --keep leaves the stack
# up with the run's backends and namespaces, for a look and for the next run; --reuse runs against a stack kept so.
# Anything else is refused, and --keep on GitHub, whose runner goes, its stack with it.
e2e_options() {
  local option
  for option in "$@"; do
    case "$option" in
      --teardown) e2e_teardown=true ;;
      --keep) e2e_keep=true ;;
      --reuse) e2e_reuse=true ;;
      *) echo "$E2E_NAME: no option $option; its own are --teardown, --keep and --reuse" >&2; checks_quit 2 ;;
    esac
  done
  if $e2e_keep && [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "$E2E_NAME: --keep is a laptop's: a GitHub runner goes, its stack with it" >&2; checks_quit 2
  fi
  if $e2e_keep && $e2e_teardown; then echo "$E2E_NAME: --keep keeps the cluster that --teardown deletes" >&2; checks_quit 2; fi
  if $e2e_reuse && [ ! -f "$e2e_kept" ]; then echo "$E2E_NAME: --reuse needs the stack a run with --keep left" >&2; checks_quit 2; fi
}

# e2e_remove: what a run made beside its compose project: its cleanups run, its backends stopped, its namespaces
# deleted, its containers removed.
e2e_remove() {
  local command pid ns
  for command in "${e2e_cleanups[@]}"; do
    eval "$command" >/dev/null 2>&1 || true
  done
  for pid in "${e2e_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      e2e_gone "$pid"
    fi
  done
  for ns in "${e2e_namespaces[@]}"; do
    kubectl delete namespace "$ns" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
  [ "${#e2e_containers[@]}" -eq 0 ] || docker rm -f "${e2e_containers[@]}" >/dev/null 2>&1 || true
}

# e2e_remove_kept [--all]: what a run kept with --keep left removed, as its own cleanup would have, in a shell of its
# own, so that its arrays are its, not this run's; with --all, its compose project too, its volumes with it.
e2e_remove_kept() {
  [ -f "$e2e_kept" ] || return 0
  (
    # shellcheck source=/dev/null
    source "$e2e_kept"
    e2e_remove
  )
  [ "${1:-}" != --all ] || "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$e2e_kept"
}

e2e_cleanup() {
  local status=$checks_status evidence
  # What the failed run leaves behind, before anything below removes it.
  if [ "$status" -ne 0 ]; then
    evidence="$(evidence_start "$E2E_NAME")"
    evidence_cluster "$evidence" "${e2e_namespaces[@]}" ff-system ff-logging
    evidence_containers "$evidence" "k3d-$FF_CLUSTER_NAME-server-0" "${e2e_containers[@]}"
    evidence_compose "$evidence" "${compose[@]}"
    evidence_logs "$evidence" "$work"
    evidence_done "$evidence" "$E2E_NAME"
  fi
  if $e2e_keep; then
    declare -p e2e_cleanups e2e_pids e2e_namespaces e2e_containers | sed 's/^declare -/declare -g/' >"$e2e_kept"
    echo "$E2E_NAME: the stack is kept, with the run's backends and namespaces: --reuse runs against it, a run without it removes it first" >&2
  else
    e2e_remove
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  if $e2e_teardown; then "$FF_REPO_ROOT/hack/k8s/cluster-down.sh" >/dev/null 2>&1 || true; fi
  if [ "$status" -ne 0 ]; then
    echo "$E2E_NAME: FAILED. Last backend log lines ($work/backend.log):" >&2
    tail -20 "$work/backend.log" >&2 2>/dev/null || true
  fi
}
on_exit e2e_cleanup

# e2e_gone <pid>: returns once the process is gone, after 30 s at most. A process a suite's section started is no child
# of the shell after it, each section running in a subshell of its own (hack/lib/sections.sh), so wait can't tell when
# it ends; the process is reaped by another, as an orphan. One that is a child is waited for: a zombie still answers.
e2e_gone() {
  local _
  wait "$1" 2>/dev/null || true
  for _ in $(seq 1 300); do
    kill -0 "$1" 2>/dev/null || return 0
    sleep 0.1
  done
}

# http_at <base URL> <method> <path> [json-body] [curl option...]: prints the body;
# the status code goes to $work/status. Extra options are passed to curl, e.g. -H 'x: y'.
http_at() {
  local base=$1 method=$2 path=$3 body=${4:-}
  shift $(($# < 4 ? $# : 4))
  local args=(-sS -o "$work/body" -w '%{http_code}' -X "$method" -H 'content-type: application/json')
  if [ -n "$body" ]; then args+=(--data "$body"); fi
  curl "${args[@]}" "$@" "$base$path" >"$work/status"
  cat "$work/body"
}
status() { cat "$work/status"; }
# archived <path>: an object of the "functions" bucket, read through SeaweedFS's filer inside the s3 container.
archived() { "${compose[@]}" exec -T s3 wget -qO- "http://127.0.0.1:8888/buckets/functions/$1" 2>/dev/null || true; }
# free_port: a free port chosen by the OS, so the test never collides with other servers on the machine, and none
# this run was given before: the ports are all chosen before anything listens, and the OS may offer a port it just
# offered again. A command substitution runs it in a subshell, so the ports given are kept in a file.
free_port() {
  local port
  for _ in $(seq 1 20); do
    port="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
    grep -qx "$port" "$work/ports-given" 2>/dev/null || break
  done
  echo "$port" >>"$work/ports-given"
  echo "$port"
}
# A random account (12 digits, ADR 0004), so runs never share a namespace.
random_account() { node -e "console.log(String(require('crypto').randomInt(1e12)).padStart(12, '0'))"; }
tenant_namespace() { printf 'ff-t-%s' "$(printf %s "$1" | sha256sum | cut -c1-12)"; }

# e2e_dependencies [service...]: PostgreSQL and S3, and the services named (keycloak, mailpit). A stack a run kept is
# reused with --reuse: what that run made beside it removed, FF's database made new, Mailpit's mail gone with its
# container, Keycloak kept, whose users each run makes its own; without --reuse, a kept stack is removed whole first.
e2e_dependencies() {
  local service
  section "resources"
  MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-3500}" "$FF_REPO_ROOT/hack/check-resources.sh"
  if $e2e_reuse; then e2e_remove_kept; else e2e_remove_kept --all; fi
  section "dependencies (compose project $E2E_PROJECT)"
  for service in "$@"; do [ "$service" != mailpit ] || e2e_fresh mailpit; done
  # A port another program holds fails compose's start without saying so: said here, but for this project's own.
  local port
  for service in "postgres $FF_PG_PORT" "s3 $FF_S3_PORT"; do
    port="${service#* }" service="${service%% *}"
    [ -n "$("${compose[@]}" ps -q "$service" 2>/dev/null)" ] || ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null ||
      fail "127.0.0.1:$port, $E2E_PROJECT's $service, is another program's: the suite's port variable moves it (FF_E2E_PG_PORT and FF_E2E_S3_PORT for L4; FF_E2E_TENANCY_ and FF_CLI_E2E_ for L5's and the ff suite's)"
  done
  e2e_up "compose dependencies" postgres s3 "$@"
  if $e2e_reuse; then
    "${compose[@]}" exec -T postgres psql -U postgres -qc 'DROP DATABASE IF EXISTS serverless_platform WITH (FORCE)' \
      -c 'CREATE DATABASE serverless_platform' >/dev/null 2>&1 || fail "FF's database could not be made new"
    echo "  reused: what the kept run made beside it removed, FF's database made new"
  fi
  echo "  postgres on 127.0.0.1:$FF_PG_PORT, s3 on 127.0.0.1:$FF_S3_PORT${1:+, and $*}"
}

e2e_cluster() {
  section "cluster"
  k3d cluster get "$FF_CLUSTER_NAME" >/dev/null 2>&1 || "$FF_REPO_ROOT/hack/k8s/cluster-up.sh" >/dev/null
  "$FF_REPO_ROOT/hack/k8s/mint-token.sh" >/dev/null
  # The logs API and the load errors read the log store (P-43): a cluster made before it gets it now.
  kubectl -n ff-system get statefulset victoria-logs >/dev/null 2>&1 || "$FF_REPO_ROOT/hack/k8s/logging-up.sh" >/dev/null
  # Closing an account deletes its log lines with the store's key (P-45).
  "$FF_REPO_ROOT/hack/k8s/log-store-key.sh" >/dev/null
  # Every function's code runs as a code image (ADR 0003): a cluster made before its registry gets it now.
  "$FF_REPO_ROOT/hack/k8s/registry-up.sh" >/dev/null
  docker image inspect ff-runtime-nodejs:24-v3 >/dev/null 2>&1 ||
    docker build -q -t ff-runtime-nodejs:24-v3 "$FF_REPO_ROOT/runtimes/nodejs" >/dev/null
  docker image inspect ff-runtime-python:3.13-v3 >/dev/null 2>&1 ||
    docker build -q -t ff-runtime-python:3.13-v3 "$FF_REPO_ROOT/runtimes/python" >/dev/null
  # Imported into the node unless it holds these very ones, 16 s saved a run: an image built again, or one the node's
  # kubelet removed to make room, is imported again.
  e2e_on_node ff-runtime-nodejs:24-v3 ff-runtime-python:3.13-v3 ||
    "$FF_REPO_ROOT/hack/k8s/load-images.sh" ff-runtime-nodejs:24-v3 ff-runtime-python:3.13-v3 >/dev/null 2>&1
  echo "  $FF_CLUSTER_NAME ready, runtime images imported"
}

# e2e_on_node <image…>: whether the cluster's node holds each image as Docker has it, by its ID, which containerd and
# Docker both take from the image's configuration.
e2e_on_node() {
  local node="k3d-$FF_CLUSTER_NAME-server-0" image id
  for image in "$@"; do
    id="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null)" || return 1
    [ -n "$id" ] && [ "$(docker exec "$node" crictl inspecti -o go-template --template '{{.status.id}}' "docker.io/library/$image" 2>/dev/null)" = "$id" ] ||
      return 1
  done
}

# e2e_build: the backend built, unless BE/dist is the build of its files as they are (hack/lib/backend-build.sh).
e2e_build() {
  if backend_built; then
    echo "  the backend's build is its sources' already"
    return 0
  fi
  backend_build >/dev/null
}

# e2e_migrate <VAR=value...>: runs the migrations from the build, as a deploy step would.
e2e_migrate() {
  (cd "$FF_REPO_ROOT/BE" && env "$@" npm run migration:run:prod) >"$work/migrations.log" 2>&1 ||
    fail "the migrations failed (see $work/migrations.log)"
}

# e2e_start_backend <log> <base URL> <VAR=value...>: starts the built backend and
# waits until it answers. It is stopped on exit.
e2e_start_backend() {
  local log=$1 url=$2 pid
  shift 2
  (cd "$FF_REPO_ROOT/BE" && exec env "$@" node dist/main.js) >"$log" 2>&1 &
  pid=$!
  e2e_pids+=("$pid")
  # A cold start reads thousands of node_modules files. With a cold page cache on
  # a spinning disk that took 23 s just to load the modules, so allow 3 minutes.
  for _ in $(seq 1 "${FF_E2E_BACKEND_START_SECONDS:-180}"); do
    kill -0 "$pid" 2>/dev/null || fail "the backend exited during startup (see $log)"
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/api-json")" = 200 ] && return 0
    sleep 1
  done
  fail "the backend did not answer on $url (see $log)"
}

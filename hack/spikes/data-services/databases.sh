#!/usr/bin/env bash
# Step 2's spike, its databases half (the step-2 plan's V-01, for ADR 0008). On a PostgreSQL 18 server of its own,
# beside the development cluster: a database and its user per customer, opaque names, TLS and SCRAM only; the
# verifier made here, so the password reaches no log; what a customer's user can and can't do; a tenant pod reaching
# the server through a NetworkPolicy rule of its own while its account's internet access is off, and nothing else
# private; the read-only signal past the plan's storage; suspension and deletion; what sampling a thousand
# databases' sizes costs; and one database brought back from a point in time with WAL-G.
#   hack/spikes/data-services/databases.sh               # about 10 minutes
#   DATABASES=200 hack/spikes/data-services/databases.sh # fewer databases for the sampling's cost
#   KEEP=1 hack/spikes/data-services/databases.sh        # leaves everything running, for a look
# Results: hack/.data-services-spike/databases.md. All it makes is removed on exit; FF's own containers, cluster
# namespaces and buckets are never touched.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
source "$repo/hack/k8s/env.sh"
"$repo/hack/check-resources.sh"

work="$repo/hack/.data-services-spike/databases"
results="$repo/hack/.data-services-spike/databases.md"
rm -rf "$work"
mkdir -p "$work"

name=ff-data-db-spike
scratch=ff-data-db-spike-restore
decoy=ff-data-db-spike-decoy
network=ff-data-db-spike
subnet=10.199.0.0/24
address=10.199.0.10
decoy_address=10.199.0.11
host_port=55440
pg_image=postgres:18.6-bookworm
client_image=postgres:18.6-alpine
image=ff-data-db:spike
node="k3d-$FF_CLUSTER_NAME-server-0"
namespace=ff-spike-data
bucket=ff-data-db-spike
DATABASES="${DATABASES:-1000}"
s3=(env AWS_ACCESS_KEY_ID=ffdevaccesskey AWS_SECRET_ACCESS_KEY=ffdevsecretkey-local-only AWS_REGION=us-east-1 AWS_PAGER=
  aws --endpoint-url "http://127.0.0.1:${FF_S3_PORT:-9003}")

cleanup() {
  if [ "${KEEP:-}" = 1 ]; then
    echo "KEEP=1: $name ($address, 127.0.0.1:$host_port), $decoy, namespace $namespace and bucket $bucket left running" >&2
    return
  fi
  kubectl delete namespace "$namespace" --wait=false >/dev/null 2>&1 || true
  docker network disconnect "$network" "$node" >/dev/null 2>&1 || true
  docker rm -f -v "$name" "$scratch" "$decoy" >/dev/null 2>&1 || true
  docker volume rm "$name-data" "$scratch-data" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  "${s3[@]}" s3 rb "s3://$bucket" --force >/dev/null 2>&1 || true
}
trap cleanup EXIT

passes=0
fails=0
note() { printf '%s\n' "$*" >>"$results"; }
ms_since() { echo $((($(date +%s%N) - $1) / 1000000)); }
# expect ok|refused "what it checks" command…: runs it, and records the outcome, and the first line of its error.
expect() {
  local want="$1" what="$2" out status=0 got detail mark
  shift 2
  out="$("$@" 2>&1)" || status=$?
  got=ok
  [ "$status" -eq 0 ] || got=refused
  detail="$(printf '%s\n' "$out" | grep -m1 -iE 'error|fatal|refused|timeout|timed out|denied|not permitted|no pg_hba' || printf '%s\n' "$out" | head -1)"
  if [ "$got" = "$want" ]; then
    mark=pass
    passes=$((passes + 1))
  else
    mark=FAIL
    fails=$((fails + 1))
  fi
  note "| $what | $want | $got | \`$(printf '%s' "$detail" | tr -d '`' | tr '|' '/' | cut -c1-150)\` | $mark |"
  printf '%-4s %s\n' "$mark" "$what" >&2
}
table() { note ""; note "| Check | Expected | Got | What it said | |"; note "|---|---|---|---|---|"; }

secret() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n' | head -c "${1:-43}"; }
opaque() { echo "ff_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"; }

# psql over TLS, verifying the server's certificate, from this machine.
conn() { echo "host=127.0.0.1 port=$host_port dbname=$3 user=$1 password=$2 sslmode=verify-full sslrootcert=$work/ca.crt connect_timeout=5"; }
as() {
  local user="$1" password="$2" db="$3"
  shift 3
  psql "$(conn "$user" "$password" "$db")" -X -v ON_ERROR_STOP=1 -At "$@"
}
admin() { as ff_admin "$admin_password" postgres "$@"; }
super() { docker exec -i -u postgres "$name" psql -X -v ON_ERROR_STOP=1 -At "$@"; }

: >"$results"
note "# Databases spike ($(date -u +%Y-%m-%dT%H:%MZ))"
note ""
note "PostgreSQL $(docker run --rm "$client_image" postgres --version | awk '{print $3}') (\`$pg_image\` with WAL-G, \`$client_image\` in the pod); psql $(psql --version | awk '{print $3}') here. Cluster \`$FF_CLUSTER_NAME\` ($FF_K3S_IMAGE)."

# ---------- the server ----------
echo "== the server" >&2
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj "/CN=FF data spike CA" \
  -keyout "$work/ca.key" -out "$work/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=ff-data-db" \
  -keyout "$work/server.key" -out "$work/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:ff-data-db,DNS:localhost,IP:%s,IP:127.0.0.1\n' "$address" >"$work/san.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.crt" -CAkey "$work/ca.key" -CAcreateserial -days 2 \
  -extfile "$work/san.ext" -out "$work/server.crt" 2>/dev/null
# Who may log in where: the backend's role to the maintenance database only; a customer's user to its namesake
# database only; the superuser over the socket only; nothing without TLS. First match wins.
cat >"$work/pg_hba.conf" <<'EOF'
# TYPE   DATABASE  USER      ADDRESS     METHOD
local    all       postgres              peer
hostssl  all       postgres  0.0.0.0/0   reject
hostssl  postgres  ff_admin  0.0.0.0/0   scram-sha-256
hostssl  sameuser  all       0.0.0.0/0   scram-sha-256
host     all       all       0.0.0.0/0   reject
host     all       all       ::/0        reject
EOF
cat >"$work/Dockerfile" <<EOF
FROM $pg_image
ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256=965a7147852435bc4b54f272799b63df826b54ef65cf7c4fc688c82b96c0c4eb
ADD --checksum=sha256:\${WALG_SHA256} https://github.com/wal-g/wal-g/releases/download/\${WALG_VERSION}/wal-g-pg-20.04-amd64 /usr/local/bin/wal-g
RUN chmod 0755 /usr/local/bin/wal-g && wal-g --version && install -d -m 0755 -o postgres -g postgres /etc/ff-tls
COPY --chown=postgres:postgres --chmod=0644 server.crt ca.crt pg_hba.conf /etc/ff-tls/
COPY --chown=postgres:postgres --chmod=0600 server.key /etc/ff-tls/server.key
EOF
docker build -q -t "$image" "$work" >/dev/null

docker network create --subnet "$subnet" "$network" >/dev/null
"${s3[@]}" s3 mb "s3://$bucket" >/dev/null
cat >"$work/walg.env" <<EOF
WALG_S3_PREFIX=s3://$bucket/backups
AWS_ENDPOINT=http://s3:8333
AWS_REGION=us-east-1
AWS_S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=ffdevaccesskey
AWS_SECRET_ACCESS_KEY=ffdevsecretkey-local-only
WALG_LIBSODIUM_KEY=$(secret 64)
WALG_LIBSODIUM_KEY_TRANSFORM=hex
WALG_COMPRESSION_METHOD=zstd
PGHOST=/var/run/postgresql
PGUSER=postgres
EOF
server_args=(-c ssl=on -c ssl_cert_file=/etc/ff-tls/server.crt -c ssl_key_file=/etc/ff-tls/server.key
  -c hba_file=/etc/ff-tls/pg_hba.conf -c password_encryption=scram-sha-256 -c log_connections=on
  -c log_statement=ddl -c max_connections=200)
docker run -d --name "$name" --network "$network" --ip "$address" -p "127.0.0.1:$host_port:5432" \
  -v "$name-data:/var/lib/postgresql" -e POSTGRES_PASSWORD="$(secret)" --env-file "$work/walg.env" \
  "$image" "${server_args[@]}" -c wal_level=replica -c archive_mode=on -c 'archive_command=wal-g wal-push %p' \
  -c archive_timeout=60 >/dev/null
# WAL-G reaches FF's development S3 by its compose name.
docker network connect ff_default "$name"
for _ in $(seq 1 120); do
  docker exec "$name" pg_isready -q -h 127.0.0.1 2>/dev/null && super -c 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done
pgdata="$(docker exec "$name" printenv PGDATA)"
note "Data directory \`$pgdata\`; the server's settings: \`${server_args[*]}\`, and WAL archiving with WAL-G."

# The backend's role: makes databases and users, never a superuser. It reads every database's size and may end a
# customer's sessions through two of PostgreSQL's predefined roles.
admin_password="$(secret)"
admin_verifier="$(node "$repo/deploy/data-db/scram-verifier.mjs" "$admin_password")"
super -c "CREATE ROLE ff_admin LOGIN CREATEDB CREATEROLE PASSWORD '$admin_verifier'" >/dev/null
super -c "GRANT pg_read_all_stats, pg_signal_backend TO ff_admin" >/dev/null

note ""
note "## A database and its user, made by the backend's role"
table
expect ok "the backend's role logs in over TLS, its password sent to the server only as a SCRAM verifier made here" admin -c 'select current_user'
expect refused "the backend's role without TLS" psql "host=127.0.0.1 port=$host_port dbname=postgres user=ff_admin password=$admin_password sslmode=disable connect_timeout=5" -XAtc 'select 1'
expect refused "the superuser over TCP, even with TLS" psql "host=127.0.0.1 port=$host_port dbname=postgres user=postgres password=x sslmode=require connect_timeout=5" -XAtc 'select 1'

make_database() { # name password → makes the user and its database as the backend would
  local db="$1" password="$2" verifier
  verifier="$(node "$repo/deploy/data-db/scram-verifier.mjs" "$password")"
  admin -c "CREATE ROLE $db LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD '$verifier'" \
    -c "GRANT $db TO ff_admin WITH INHERIT FALSE, SET TRUE" \
    -c "CREATE DATABASE $db OWNER $db" \
    -c "SET ROLE $db" -c "REVOKE ALL ON DATABASE $db FROM PUBLIC" -c 'RESET ROLE'
}
a="$(opaque)"
a_password="$(secret)"
b="$(opaque)"
b_password="$(secret)"
probe="$(opaque)"
admin -c "CREATE ROLE $probe LOGIN PASSWORD '$(node "$repo/deploy/data-db/scram-verifier.mjs" "$(secret)")'" >/dev/null
expect refused "CREATE DATABASE … OWNER another role, without the right to SET ROLE to it (PostgreSQL 16 and later)" admin -c "CREATE DATABASE $probe OWNER $probe"
admin -c "DROP ROLE $probe" >/dev/null
expect ok "a customer's user and database: CREATE ROLE, GRANT … WITH INHERIT FALSE, SET TRUE, CREATE DATABASE … OWNER, then as its owner REVOKE ALL FROM PUBLIC" make_database "$a" "$a_password"
make_database "$b" "$b_password" >/dev/null
note ""
note "Names: \`$a\` and \`$b\`, the same for the user and its database, \`ff_\` and 24 random hexadecimal characters."
for password in "$a_password" "$admin_password"; do
  if docker logs "$name" 2>&1 | grep -F "$password" >/dev/null; then
    note "- **The password is in the server's log** (log_statement=ddl): FAIL"
    fails=$((fails + 1))
  fi
done
note "- The server's log, with every DDL statement in it: the verifiers, never a password ($(docker logs "$name" 2>&1 | grep -c 'SCRAM-SHA-256\$4096' || true) statements logged with a verifier)."

note ""
note "## What a customer's user can do"
table
A() { as "$a" "$a_password" "$a" "$@"; }
expect ok "its own database, over TLS, the certificate verified" A -c 'select current_user, current_database()'
expect ok "tables of its own, and rows" A -c 'create table orders (id int primary key, note text)' -c "insert into orders select g, 'before' from generate_series(1, 100) g"
expect ok "PostgreSQL's trusted extensions: pgcrypto, citext, hstore, pg_trgm, uuid-ossp" A -c 'create extension pgcrypto' -c 'create extension citext' -c 'create extension hstore' -c 'create extension pg_trgm' -c 'create extension "uuid-ossp"'
expect ok "schemas of its own" A -c 'create schema app' -c 'create table app.t (x int)'
expect refused "an extension that isn't trusted: dblink" A -c 'create extension dblink'
expect refused "an extension that isn't trusted: postgres_fdw" A -c 'create extension postgres_fdw'
expect refused "a program run by the server: COPY … TO PROGRAM" A -c "copy (select 1) to program 'id'"
expect refused "a file of the server: pg_read_file" A -c "select pg_read_file('/etc/passwd')"
expect refused "another database: CREATE DATABASE" A -c 'create database other'
expect refused "another role: CREATE ROLE" A -c 'create role other'
expect refused "the other customer's database, as itself" as "$a" "$a_password" "$b"
expect refused "the maintenance database, postgres" as "$a" "$a_password" postgres
expect refused "its own database without TLS" psql "host=127.0.0.1 port=$host_port dbname=$a user=$a password=$a_password sslmode=disable connect_timeout=5" -XAtc 'select 1'
expect refused "a wrong password" as "$a" "wrong-$a_password" "$a" -c 'select 1'
note ""
note "- What it sees of the others: \`pg_database\` lists $(A -c "select count(*) from pg_database where datname like 'ff\_%'") databases named \`ff_…\`, and \`pg_roles\` their users: why the names say nothing."
as "$b" "$b_password" "$b" -c 'select pg_sleep(3)' >/dev/null 2>&1 &
sleeper=$!
sleep 1
note "- Another user's session in \`pg_stat_activity\`, as the customer's user reads it: its query is \`$(A -c "select coalesce(query, '(null)') from pg_stat_activity where usename = '$b' limit 1")\`."
wait "$sleeper" 2>/dev/null || true
held=()
for _ in $(seq 1 10); do
  psql "$(conn "$a" "$a_password" "$a")" -XAtc 'select pg_sleep(8)' >/dev/null 2>&1 &
  held+=($!)
done
sleep 2
expect refused "an eleventh connection, past the plan's CONNECTION LIMIT 10" A -c 'select 1'
kill "${held[@]}" 2>/dev/null || true
wait "${held[@]}" 2>/dev/null || true
# A client gone leaves its session until the server next writes to it: end them, as the backend can.
admin -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where usename = '$a'" >/dev/null

# The connection string FF gives, as the commonest drivers read its sslmode: libpq's (psql, psycopg, most others)
# and node-postgres's, whose require checks the certificate as libpq's verify-full does.
clients="$repo/hack/.data-services-spike/clients"
if [ ! -d "$clients/node_modules/pg" ]; then
  mkdir -p "$clients" && (cd "$clients" && { [ -f package.json ] || npm init -y >/dev/null; } && npm install --silent --no-audit --no-fund pg@8.23.1 >/dev/null)
fi
url="postgresql://$a:$a_password@127.0.0.1:$host_port/$a"
node_pg() { # extra environment… -- connection string
  local environment=()
  while [ "$1" != -- ]; do environment+=("$1"); shift; done
  shift
  env "${environment[@]}" node -e "
    const { Client } = require('$clients/node_modules/pg');
    const client = new Client({ connectionString: process.argv[1], connectionTimeoutMillis: 5000 });
    client.connect().then(() => client.query('select current_user')).then((r) => { console.log(r.rows[0].current_user); return client.end(); })
      .catch((e) => { console.error(e.message); process.exit(1); });" "$1"
}
note ""
note "## The connection string's sslmode, as drivers read it"
note ""
note "node-postgres $(node -p "require('$clients/node_modules/pg/package.json').version") (the small app's); libpq $(psql --version | awk '{print $3}') (psql). The server's certificate comes from the run's own CA, as a development server's would."
table
expect ok "libpq, sslmode=require: encrypted, the certificate not checked" psql "$url?sslmode=require" -XAtc 'select 1'
expect refused "libpq, sslmode=verify-full and no CA given" env HOME="$work" psql "$url?sslmode=verify-full" -XAtc 'select 1'
expect ok "libpq, sslmode=verify-full and the CA in sslrootcert" psql "$url?sslmode=verify-full&sslrootcert=$work/ca.crt" -XAtc 'select 1'
expect refused "node-postgres, sslmode=require: it checks the certificate, against Node.js's CAs" node_pg -- "$url?sslmode=require"
expect ok "node-postgres, sslmode=require, the CA in NODE_EXTRA_CA_CERTS" node_pg NODE_EXTRA_CA_CERTS="$work/ca.crt" -- "$url?sslmode=require"
expect ok "node-postgres, sslmode=verify-full and the CA in sslrootcert" node_pg -- "$url?sslmode=verify-full&sslrootcert=$work/ca.crt"
expect ok "node-postgres, sslmode=no-verify (its own word, which libpq refuses)" node_pg -- "$url?sslmode=no-verify"
expect refused "libpq, sslmode=no-verify" psql "$url?sslmode=no-verify" -XAtc 'select 1'

# ---------- from a tenant pod ----------
echo "== a tenant pod" >&2
docker run -d --name "$decoy" --network "$network" --ip "$decoy_address" -e POSTGRES_HOST_AUTH_METHOD=trust "$client_image" >/dev/null
docker network connect --gw-priority -1 "$network" "$node"
note ""
note "## A tenant pod, its account's internet access off"
note ""
note "The cluster's node joined the server's Docker network as its lowest gateway priority; its default route stays \`$(docker exec "$node" ip route show default | head -1)\`. A decoy PostgreSQL that trusts everyone sits at $decoy_address, the server at $address."
runtime_class=""
kubectl get runtimeclass gvisor >/dev/null 2>&1 && runtime_class=gvisor
policy() { # with-data-rule|without
  local data_rule=""
  [ "$1" = with-data-rule ] && data_rule="    - to: [{ipBlock: {cidr: $address/32}}]
      ports: [{protocol: TCP, port: 5432}]"
  kubectl apply -f - >/dev/null <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: {name: ff-default-deny, namespace: $namespace}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: []
  egress:
    - to: [{namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}, podSelector: {matchLabels: {k8s-app: kube-dns}}}]
      ports: [{protocol: UDP, port: 53}, {protocol: TCP, port: 53}]
$data_rule
EOF
}
kubectl create namespace "$namespace" >/dev/null
kubectl label namespace "$namespace" pod-security.kubernetes.io/enforce=restricted >/dev/null
kubectl -n "$namespace" create configmap data-db-ca --from-file=ca.crt="$work/ca.crt" >/dev/null
policy with-data-rule
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: {name: client, namespace: $namespace}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  enableServiceLinks: false
  ${runtime_class:+runtimeClassName: $runtime_class}
  securityContext: {runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: {type: RuntimeDefault}}
  containers:
    - name: client
      image: $client_image
      command: [sleep, "900"]
      env: [{name: HOME, value: /tmp}]
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      volumeMounts: [{name: ca, mountPath: /tls}, {name: tmp, mountPath: /tmp}]
  volumes: [{name: ca, configMap: {name: data-db-ca}}, {name: tmp, emptyDir: {}}]
EOF
kubectl -n "$namespace" wait --for=condition=Ready pod/client --timeout=240s >/dev/null
note "The pod: \`$client_image\`, uid 10001, a read-only root, no capability${runtime_class:+, under gVisor}."
in_pod() { kubectl -n "$namespace" exec client -- "$@"; }
pod_psql() { in_pod env PGCONNECT_TIMEOUT=5 psql "host=$1 port=5432 dbname=$2 user=$3 password=$4 sslmode=${5:-verify-full} sslrootcert=/tls/ca.crt" -XAtc 'select current_user, inet_client_addr()'; }
table
expect ok "the server, as the customer's user, through the rule for $address/32 port 5432" pod_psql "$address" "$a" "$a" "$a_password"
note ""
note "- The server sees the pod's connection come from \`$(pod_psql "$address" "$a" "$a" "$a_password" | cut -d'|' -f2)\`: the node's address on that network, the cluster masquerading what leaves it."
table
expect refused "the other customer's database, from the pod" pod_psql "$address" "$b" "$a" "$a_password"
expect refused "the decoy PostgreSQL next to the server, $decoy_address" pod_psql "$decoy_address" postgres postgres x disable
expect ok "a TCP connection to the server's port, with the pod's nc (so that a refusal below is the network's)" in_pod nc -z -w 4 "$address" 5432
expect refused "the internet, 1.1.1.1:443" in_pod nc -z -w 4 1.1.1.1 443
expect refused "another port of the server, 22" in_pod nc -z -w 4 "$address" 22
policy without
sleep 3
expect refused "the server once the rule is gone, the rest of the policy unchanged" pod_psql "$address" "$a" "$a" "$a_password"
policy with-data-rule
sleep 3
expect ok "the server again, the rule back" pod_psql "$address" "$a" "$a" "$a_password"

# ---------- past the plan's storage ----------
echo "== the read-only signal" >&2
note ""
note "## Past the plan's storage: new sessions read-only"
table
expect refused "the backend's role sets the database's default: ALTER DATABASE … SET (only its owner may)" admin -c "ALTER DATABASE $a SET default_transaction_read_only = on"
A -c 'create table uploads (id int)' -c 'insert into uploads select generate_series(1, 10)' >/dev/null
expect ok "the backend's role sets the user's default in its database: ALTER ROLE … IN DATABASE … SET" admin -c "ALTER ROLE $a IN DATABASE $a SET default_transaction_read_only = on"
expect refused "a new session's write" A -c 'insert into uploads values (11)'
note ""
note "- What the app reads: \`$(A -c 'insert into uploads values (11)' 2>&1 | head -1)\`, SQLSTATE 25006."
table
expect ok "a new session's read" A -c 'select count(*) from uploads'
expect ok "the session turns it off for itself, and deletes what it no longer needs" A -c 'set default_transaction_read_only = off' -c 'delete from uploads where id > 5'
expect ok "a transaction asked read-write" A -c 'begin read write' -c 'insert into uploads values (6)' -c 'commit'
expect refused "the customer's user takes the setting away, from a read-only session" A -c "ALTER ROLE $a IN DATABASE $a RESET default_transaction_read_only"
expect ok "the customer's user takes the setting away, once its session is read-write: a signal, not a wall" A -c 'set default_transaction_read_only = off' -c "ALTER ROLE $a IN DATABASE $a RESET default_transaction_read_only"
admin -c "ALTER ROLE $a IN DATABASE $a SET default_transaction_read_only = on" >/dev/null
psql "$(conn "$a" "$a_password" "$a")" -XAtc 'select pg_sleep(6)' >/dev/null 2>&1 &
sleeper=$!
sleep 1
expect ok "the backend's role ends the user's sessions under way (pg_signal_backend), so that each starts read-only again" admin -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where usename = '$a' and pid <> pg_backend_pid()"
wait "$sleeper" 2>/dev/null || true
admin -c "ALTER ROLE $a IN DATABASE $a RESET default_transaction_read_only" >/dev/null
expect ok "back under the limit: the setting reset, writes again" A -c 'insert into uploads values (7)'
A -c 'drop table uploads' >/dev/null

# ---------- suspension ----------
note ""
note "## An account suspended, then reactivated"
table
psql "$(conn "$a" "$a_password" "$a")" -XAtc 'select pg_sleep(6)' >/dev/null 2>&1 &
sleeper=$!
sleep 1
expect ok "ALTER ROLE … NOLOGIN, then its sessions ended" admin -c "ALTER ROLE $a NOLOGIN" -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where usename = '$a'"
wait "$sleeper" 2>/dev/null && sessions_ended=no || sessions_ended=yes
note ""
note "- The session that was running ended: $sessions_ended."
table
expect refused "a new login while suspended" A -c 'select 1'
admin -c "ALTER ROLE $a LOGIN" >/dev/null
expect ok "reactivated, ALTER ROLE … LOGIN: the user logs in again, its data as it was" A -c 'select count(*) from orders'

# ---------- sampling ----------
echo "== sampling $DATABASES databases" >&2
note ""
note "## What sampling every database's size costs"
started="$(date +%s%N)"
{
  for i in $(seq -w 1 10); do echo "CREATE DATABASE ff_default_$i;"; done
} | super -q >/dev/null
default_created="$(ms_since "$started")"
{
  for i in $(seq -w 1 10); do echo "DROP DATABASE ff_default_$i;"; done
} | super -q >/dev/null
note ""
note "Ten databases made one after the other with PostgreSQL's default strategy (WAL_LOG, the template copied through the WAL, no checkpoint) on a server of a few: ${default_created} ms, $((default_created / 10)) ms each."
started="$(date +%s%N)"
{
  for i in $(seq -w 1 "$DATABASES"); do echo "CREATE DATABASE ff_sample_$i STRATEGY FILE_COPY;"; done
} | super -q >/dev/null
created="$(ms_since "$started")"
sample() {
  local out
  out="$(admin -c '\timing on' -c "select count(*), pg_size_pretty(sum(size)), sum(connections) from (select pg_database_size(d.oid) as size, s.numbackends as connections from pg_database d left join pg_stat_database s on s.datid = d.oid) x")"
  printf '%s' "$out" | tr '\n' ' '
}
note ""
note "Then $DATABASES empty databases made with \`STRATEGY FILE_COPY\` (a checkpoint each, less WAL to archive) in ${created} ms ($((created / DATABASES)) ms each); the server's disk: $(docker exec "$name" du -sh "$pgdata" | cut -f1). The hourly sample, every database's \`pg_database_size\` and \`pg_stat_database.numbackends\`, by the backend's role, three times:"
note ""
for run in 1 2 3; do note "- run $run: \`$(sample)\`"; done
started="$(date +%s%N)"
{
  for i in $(seq -w 1 "$DATABASES"); do echo "DROP DATABASE ff_sample_$i;"; done
} | super -q >/dev/null
note "- dropped again in $(ms_since "$started") ms."

# ---------- point in time ----------
echo "== a database from a point in time" >&2
note ""
note "## One database brought back from a point in time, with WAL-G"
table
started="$(date +%s%N)"
expect ok "a base backup: wal-g backup-push" docker exec -u postgres "$name" wal-g backup-push "$pgdata"
note ""
note "- The base backup took $(ms_since "$started") ms ($(docker exec "$name" du -sh "$pgdata" | cut -f1) of data)."
A -c 'select count(*) from orders' >/dev/null
sleep 2
target="$(A -c "select to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 2
A -c "insert into orders select g, 'after' from generate_series(101, 200) g" >/dev/null
super -c 'select pg_switch_wal()' >/dev/null
for _ in $(seq 1 60); do
  [ "$(super -c "select last_archived_wal >= (select pg_walfile_name(pg_current_wal_lsn() - 1)) from pg_stat_archiver")" = t ] && break
  sleep 1
done
note "- 100 rows before $target, 100 after, the segment shipped: \`$(super -c 'select archived_count, failed_count, last_archived_wal from pg_stat_archiver')\`."
started="$(date +%s%N)"
docker volume create "$scratch-data" >/dev/null
docker run --rm -u postgres -v "$scratch-data:/var/lib/postgresql" --env-file "$work/walg.env" --network ff_default \
  --entrypoint bash "$image" -c "set -e; mkdir -p '$pgdata' && chmod 700 '$pgdata' && wal-g backup-fetch '$pgdata' LATEST && touch '$pgdata/recovery.signal' \
    && printf \"recovery_target_time = '%s'\nrecovery_target_action = 'promote'\n\" '$target' >>'$pgdata/postgresql.auto.conf'" >"$work/fetch.log" 2>&1
docker run -d --name "$scratch" -u postgres -v "$scratch-data:/var/lib/postgresql" --env-file "$work/walg.env" --network ff_default \
  "$image" postgres -c archive_mode=off -c 'restore_command=wal-g wal-fetch %f %p' -c max_connections=200 >/dev/null
for _ in $(seq 1 120); do
  [ "$(docker exec -u postgres "$scratch" psql -XAtc 'select not pg_is_in_recovery()' 2>/dev/null)" = t ] && break
  sleep 1
done
restored_at="$(ms_since "$started")"
docker logs "$scratch" >"$work/restore.log" 2>&1 || true
expect ok "the server restored elsewhere, to $target, and open" docker exec -u postgres "$scratch" psql -XAtc 'select not pg_is_in_recovery()'
a2="$(opaque)"
a2_password="$(secret)"
make_database "$a2" "$a2_password" >/dev/null
docker exec -u postgres "$scratch" pg_dump -Fc -d "$a" >"$work/a.dump"
expect ok "that one database copied into a new one of the account's: pg_dump, then pg_restore as its new user" \
  pg_restore -d "$(conn "$a2" "$a2_password" "$a2")" --no-owner --exit-on-error "$work/a.dump"
note ""
note "- The new database holds \`$(as "$a2" "$a2_password" "$a2" -c "select count(*) || ' rows, ' || count(*) filter (where note = 'after') || ' of them written after the target' from orders")\`, its extensions \`$(as "$a2" "$a2_password" "$a2" -c "select string_agg(extname, ', ' order by extname) from pg_extension where extname <> 'plpgsql'")\`. From the fetch to the copy: $(( $(ms_since "$started") )) ms, the server open after ${restored_at} ms."

# ---------- deletion ----------
note ""
note "## A database deleted, as a closed account's"
table
expect refused "DROP DATABASE as the backend's role, which doesn't own it" admin -c "DROP DATABASE $b"
expect ok "SET ROLE to its user, DROP DATABASE … WITH (FORCE), RESET ROLE, DROP ROLE" admin -c "SET ROLE $b" -c "DROP DATABASE $b WITH (FORCE)" -c 'RESET ROLE' -c "DROP ROLE $b"
expect refused "its user logs in no more" as "$b" "$b_password" "$b" -c 'select 1'

note ""
note "**$passes checks passed, $fails failed.**"
echo "databases: $passes passed, $fails failed; $results" >&2
[ "$fails" -eq 0 ]

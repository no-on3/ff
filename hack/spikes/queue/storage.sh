#!/usr/bin/env bash
# The storage half of step 3's spike (the step-3 plan's Q-01): a PostgreSQL 15 of its own, as FF's database runs
# (postgres:15.19-alpine3.24, CI's), pgmq installed into it as plain SQL, as on a server that can't add extensions,
# then storage.mjs's measures for pgmq and for FF's own table, and a backup restored into another database.
#   hack/spikes/queue/storage.sh                     # about 3 minutes
#   MESSAGES=5000 hack/spikes/queue/storage.sh       # quicker
# Prints storage.mjs's JSON lines, then the round trip's. Removes its container on exit.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$FF_REPO_ROOT/hack/.spike-queue"
container=ff-spike-queue-pg
image=postgres:15.19-alpine3.24
# pgmq's release, by its tag's source archive: the file the SQL-only install runs, checked before it is read.
pgmq_version=1.13.0
pgmq_sha256=c980705ffa2a731b69f3d26be5650d6fbcc76b2b9add67b138da4ee74a4579a5

"$FF_REPO_ROOT/hack/check-resources.sh"
mkdir -p "$work"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

if [ ! -f "$work/pgmq-$pgmq_version.tar.gz" ]; then
  curl -sSL --fail -o "$work/pgmq-$pgmq_version.tar.gz.part" "https://github.com/pgmq/pgmq/archive/refs/tags/v$pgmq_version.tar.gz"
  mv "$work/pgmq-$pgmq_version.tar.gz.part" "$work/pgmq-$pgmq_version.tar.gz"
fi
echo "$pgmq_sha256  $work/pgmq-$pgmq_version.tar.gz" | sha256sum --check --quiet
rm -rf "$work/pgmq" && mkdir "$work/pgmq"
tar -xzf "$work/pgmq-$pgmq_version.tar.gz" -C "$work/pgmq" --strip-components=1 "pgmq-$pgmq_version/pgmq-extension/sql/pgmq.sql"

docker run -d --name "$container" -e POSTGRES_PASSWORD=spike -p 127.0.0.1::5432 "$image" >/dev/null
for _ in $(seq 60); do docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && break; sleep 1; done
sleep 1
port="$(docker port "$container" 5432 | head -1 | cut -d: -f2)"
psql_in() { docker exec -i "$container" psql -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
psql_in -c 'CREATE DATABASE spike'
# As a database's owner can on a managed PostgreSQL: no extension, the objects in a schema of their own.
started=$(date +%s%N)
psql_in -d spike <"$work/pgmq/pgmq-extension/sql/pgmq.sql" >/dev/null
echo "{\"design\":\"pgmq\",\"measure\":\"installed as plain SQL\",\"value\":$(( ($(date +%s%N) - started) / 1000000 )),\"unit\":\"ms\",\"note\":\"$(psql_in -d spike -c "SELECT count(*) FROM pg_proc WHERE pronamespace = 'pgmq'::regnamespace") functions in schema pgmq, $(psql_in -d spike -c "SELECT count(*) FROM pg_extension WHERE extname = 'pgmq'") extension\"}"

MODULES="$FF_REPO_ROOT/BE" DATABASE_URL="postgres://postgres:spike@127.0.0.1:$port/spike" node "$here/storage.mjs"

# A backup restored elsewhere: pgmq's schema comes with it, its functions and a queue's messages; FF's table too.
psql_in -d spike -c "SELECT pgmq.create('kept')" >/dev/null
psql_in -d spike -c "SELECT pgmq.send('kept', '{\"order\": 1}')" >/dev/null
psql_in -d spike -c 'CREATE TABLE queue_messages (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, queue_id integer NOT NULL, body text NOT NULL)'
psql_in -d spike -c "INSERT INTO queue_messages (queue_id, body) VALUES (1, 'kept')"
docker exec "$container" pg_dump -U postgres -Fc spike >"$work/spike.dump"
psql_in -c 'CREATE DATABASE restored'
docker exec -i "$container" pg_restore -U postgres -d restored --exit-on-error <"$work/spike.dump"
pgmq_back="$(psql_in -d restored -c "SELECT message->>'order' FROM pgmq.read('kept', 30, 1)")"
own_back="$(psql_in -d restored -c 'SELECT body FROM queue_messages')"
echo "{\"design\":\"both\",\"measure\":\"a backup restored elsewhere, read there\",\"value\":$([ "$pgmq_back" = 1 ] && [ "$own_back" = kept ] && echo true || echo false),\"unit\":\"boolean\",\"note\":\"pgmq read '$pgmq_back', the table '$own_back'\"}"

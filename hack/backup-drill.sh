#!/usr/bin/env bash
# The restore drill (deploy/backup/README.md): FF's database and Keycloak's, one customer's database, and the
# bucket's legal records, backed up to a second site and restored, on Docker alone, in a few minutes. Monthly, and
# after any change to the backups; --record adds its outcome to docs/backup-drills.md.
#   1. A primary S3 (FF's bucket) and a second site's S3, each a SeaweedFS of its own.
#   2. The reference PostgreSQL (deploy/backup/postgres-walg), FF's schema made by its migrations (from the
#      backend's image), and Keycloak's database beside it; WAL archived to the second site by WAL-G, encrypted.
#   3. A base backup; then rows written, the target time noted, and rows written after it.
#   4. A new server restored from the second site to the target time: what came before is there, what came after
#      isn't, in both databases; the ledger still balanced; the time it took, against the 4 hours promised.
#   5. The customers' server (deploy/data-db), archiving under a prefix and a key of its own: two customers'
#      databases made by the backend's own code, rows deleted by mistake after a target time; the whole server
#      restored elsewhere to that time, archiving nothing, and that one database copied into a new one of the
#      account's, as the runbook does: the rows deleted back, its tables its new user's, the live databases untouched.
#   6. The invoices and withholding certificates copied to the second site with rclone, one lost on the primary,
#      and copied back, byte for byte.
#   7. Functions' packages synced there by the same mirror: one FF deleted goes from the copy, set aside 30 days
#      first; a bucket that lost them all deletes nothing at the site; they come back from it, byte for byte.
#   hack/backup-drill.sh [--record]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
record=false
[ "${1:-}" = "--record" ] && record=true
prefix="ff-drill-$$"
network="$prefix"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$prefix-site" "$prefix-s3" "$prefix-primary" "$prefix-restored" "$prefix-data" "$prefix-scratch" >/dev/null 2>&1 || true
  docker volume rm "$prefix-primary-data" "$prefix-restored-data" "$prefix-data-data" "$prefix-scratch-data" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
source "$repo/hack/lib/checks.sh"
on_exit cleanup
random() { head -c 18 /dev/urandom | base64 | tr -d '/+=\n'; }
"$repo/hack/check-resources.sh"

section "images"
docker build -q -t ff-postgres-walg:drill "$repo/deploy/backup/postgres-walg" >/dev/null
docker build -q -t ff-data-db:drill "$repo/deploy/data-db" >/dev/null
docker build -q -t ff-backend:drill "$repo/BE" >/dev/null
echo "  ff-postgres-walg (PostgreSQL 15.19, WAL-G 3.0.9), ff-data-db (PostgreSQL 18.6, WAL-G 3.0.9) and ff-backend built"

section "two sites"
docker network create "$network" >/dev/null
s3_key="drill$(random | cut -c1-10)" s3_secret="$(random)"
cat >"$work/s3.json" <<JSON
{"identities": [{"name": "drill", "credentials": [{"accessKey": "$s3_key", "secretKey": "$s3_secret"}], "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}
JSON
chmod 644 "$work/s3.json"
for s3 in s3 site; do
  docker run -d --name "$prefix-$s3" --network "$network" --network-alias "$s3" -v "$work/s3.json:/etc/seaweedfs/s3.json:ro" chrislusf/seaweedfs:4.48 \
    server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null
done
# rclone_run <command...>: a command in rclone 1.75.1's image on the drill's network, both sites configured;
# rclone <args...>: rclone itself.
rclone_env=()
rclone_run() {
  docker run --rm --network "$network" -v "$work:/work" --user "$(id -u):$(id -g)" -e HOME=/tmp -e RCLONE_CONFIG=/dev/null "${rclone_env[@]}" --entrypoint "$1" \
    -e RCLONE_CONFIG_PRIMARY_TYPE=s3 -e RCLONE_CONFIG_PRIMARY_PROVIDER=SeaweedFS -e RCLONE_CONFIG_PRIMARY_ENDPOINT=http://s3:8333 \
    -e RCLONE_CONFIG_PRIMARY_ACCESS_KEY_ID="$s3_key" -e RCLONE_CONFIG_PRIMARY_SECRET_ACCESS_KEY="$s3_secret" \
    -e RCLONE_CONFIG_SITE_TYPE=s3 -e RCLONE_CONFIG_SITE_PROVIDER=SeaweedFS -e RCLONE_CONFIG_SITE_ENDPOINT=http://site:8333 \
    -e RCLONE_CONFIG_SITE_ACCESS_KEY_ID="$s3_key" -e RCLONE_CONFIG_SITE_SECRET_ACCESS_KEY="$s3_secret" \
    rclone/rclone:1.75.1 "${@:2}"
}
rclone() { rclone_run rclone "$@"; }
for _ in $(seq 1 60); do rclone mkdir site:ff-backups >/dev/null 2>&1 && rclone mkdir primary:functions >/dev/null 2>&1 && break; sleep 1; done
check "a primary bucket and the second site's" "functions ff-backups" "$(rclone lsd primary: | awk '{print $NF}') $(rclone lsd site: | awk '{print $NF}')"

section "the primary PostgreSQL, archiving to the second site"
pg_password="$(random)"
walg_key="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
walg=(-e WALG_S3_PREFIX=s3://ff-backups/postgres -e AWS_ENDPOINT=http://site:8333 -e AWS_REGION=us-east-1 -e AWS_S3_FORCE_PATH_STYLE=true
  -e AWS_ACCESS_KEY_ID="$s3_key" -e AWS_SECRET_ACCESS_KEY="$s3_secret" -e WALG_LIBSODIUM_KEY="$walg_key" -e WALG_LIBSODIUM_KEY_TRANSFORM=hex
  -e WALG_COMPRESSION_METHOD=zstd -e PGHOST=/var/run/postgresql)
docker run -d --name "$prefix-primary" --network "$network" --network-alias primary -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=ff \
  "${walg[@]}" -v "$prefix-primary-data:/var/lib/postgresql/data" ff-postgres-walg:drill >/dev/null
# psql_on <container> <database> <sql>: one value, or rows, as the drill reads them.
psql_on() { docker exec "$1" psql -U postgres -d "$2" -v ON_ERROR_STOP=1 -qtA -c "$3"; }
for _ in $(seq 1 60); do
  [ "$(docker exec "$prefix-primary" pg_isready -U postgres -d ff 2>/dev/null)" ] && psql_on "$prefix-primary" ff 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
check "it archives every segment, at least every 5 minutes" "on wal-g wal-push %p 5min" \
  "$(psql_on "$prefix-primary" ff 'SHOW archive_mode') $(psql_on "$prefix-primary" ff 'SHOW archive_command') $(psql_on "$prefix-primary" ff 'SHOW archive_timeout')"
docker run --rm --network "$network" -e NODE_ENV=production -e DB_HOST=primary -e DB_PORT=5432 -e DB_USERNAME=postgres \
  -e DB_PASSWORD="$pg_password" -e DB_NAME=ff ff-backend:drill node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js >"$work/migrations.log" 2>&1 \
  || { tail -20 "$work/migrations.log"; fail "the migrations failed"; }
psql_on "$prefix-primary" postgres "CREATE DATABASE keycloak" >/dev/null
psql_on "$prefix-primary" keycloak "CREATE TABLE realm (name text PRIMARY KEY); INSERT INTO realm VALUES ('ff')" >/dev/null
migrations="$(psql_on "$prefix-primary" ff 'SELECT count(*) FROM migrations')"
check "FF's schema, made by its migrations, and Keycloak's database beside it" "true ff" \
  "$([ "$migrations" -gt 10 ] && echo true || echo false) $(psql_on "$prefix-primary" keycloak 'SELECT name FROM realm')"

section "a base backup, then rows before and after the target time"
docker exec -u postgres "${walg[@]}" "$prefix-primary" wal-g backup-push /var/lib/postgresql/data >"$work/backup.log" 2>&1 || { tail -20 "$work/backup.log"; fail "the base backup failed"; }
check "a base backup at the second site" 1 "$(docker exec -u postgres "${walg[@]}" "$prefix-primary" wal-g backup-list 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')"
# credit <account> <millimes> <key>: a balanced ledger transaction, as a transfer received writes it.
credit() {
  psql_on "$prefix-primary" ff "
    INSERT INTO accounts (id, name, plan_id, status) VALUES ('$1', 'Drill $1', 'beta', 'active');
    INSERT INTO ledger_accounts (account_id, type, currency) VALUES ('$1', 'wallet', 'TND');
    INSERT INTO ledger_accounts (type, currency) VALUES ('provider_clearing', 'TND') ON CONFLICT DO NOTHING;
    WITH t AS (INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('topup', '$3') RETURNING id)
    INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor)
    SELECT t.id, a.id, CASE a.type WHEN 'wallet' THEN $2 ELSE -($2) END FROM t, ledger_accounts a
     WHERE a.currency = 'TND' AND (a.account_id = '$1' OR (a.account_id IS NULL AND a.type = 'provider_clearing'))" >/dev/null
}
credit 900000000001 50000 drill:before
psql_on "$prefix-primary" keycloak "INSERT INTO realm VALUES ('before')" >/dev/null
sleep 1
target="$(psql_on "$prefix-primary" ff "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 1
credit 900000000002 70000 drill:after
psql_on "$prefix-primary" keycloak "INSERT INTO realm VALUES ('after')" >/dev/null
# The segment holding the last rows goes now, as archive_timeout would send it within 5 minutes.
psql_on "$prefix-primary" ff 'SELECT pg_switch_wal()' >/dev/null
for _ in $(seq 1 60); do
  [ "$(psql_on "$prefix-primary" ff "SELECT last_archived_wal >= pg_walfile_name(pg_current_wal_lsn() - 1) FROM pg_stat_archiver")" = t ] && break
  sleep 1
done
check "the last segment archived, none failing" "t 0" \
  "$(psql_on "$prefix-primary" ff "SELECT last_archived_wal >= pg_walfile_name(pg_current_wal_lsn() - 1) FROM pg_stat_archiver") $(psql_on "$prefix-primary" ff 'SELECT failed_count FROM pg_stat_archiver')"
rclone cat --max-size 100M --include '*' site:ff-backups/postgres >"$work/site.bin" 2>/dev/null || true
# The rows are encrypted. WAL-G's own metadata names the databases and their tables, for partial restores: FF's
# schema, which its repository shows anyway, but no customer's data.
check "the second site holds no row readable without the key: neither an account nor a ledger key" "0 true" \
  "$(grep -ac 'Drill 90000000000\|drill:before\|drill:after' "$work/site.bin" || true) $([ -s "$work/site.bin" ] && echo true || echo false)"

section "the restore, to the target time ($target)"
restore_started="$(date +%s)"
docker run --rm -u postgres "${walg[@]}" --network "$network" -v "$prefix-restored-data:/var/lib/postgresql/data" ff-postgres-walg:drill \
  bash -c "wal-g backup-fetch /var/lib/postgresql/data LATEST && touch /var/lib/postgresql/data/recovery.signal &&
    printf \"recovery_target_time = '%s'\nrecovery_target_action = 'promote'\n\" '$target' >>/var/lib/postgresql/data/postgresql.auto.conf" \
  >"$work/fetch.log" 2>&1 || { tail -20 "$work/fetch.log"; fail "the base backup could not be fetched"; }
docker run -d --name "$prefix-restored" --network "$network" -e POSTGRES_PASSWORD=unused "${walg[@]}" \
  -v "$prefix-restored-data:/var/lib/postgresql/data" ff-postgres-walg:drill >/dev/null
for _ in $(seq 1 120); do
  [ "$(psql_on "$prefix-restored" ff 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ] && break
  sleep 1
done
restore_seconds=$(($(date +%s) - restore_started))
check "a new server, from the second site alone, replays the segments and opens" f "$(psql_on "$prefix-restored" ff 'SELECT pg_is_in_recovery()')"
check "FF's database: the account and the credit before the target, not after" "900000000001 50.000" \
  "$(psql_on "$prefix-restored" ff "SELECT string_agg(id, ' ') FROM accounts WHERE id LIKE '9000000000%'") $(psql_on "$prefix-restored" ff "SELECT to_char(sum(e.amount_minor) / 1000.0, 'FM999990.000') FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id WHERE a.type = 'wallet'")"
check "the ledger still balanced, every migration there" "0 $migrations" \
  "$(psql_on "$prefix-restored" ff 'SELECT coalesce(sum(amount_minor), 0) FROM ledger_entries') $(psql_on "$prefix-restored" ff 'SELECT count(*) FROM migrations')"
check "Keycloak's database: the same point in time" "before ff" "$(psql_on "$prefix-restored" keycloak 'SELECT string_agg(name, $$ $$ ORDER BY name) FROM realm')"
check "the restored server archives too: its configuration came with the backup" "on" "$(psql_on "$prefix-restored" ff 'SHOW archive_mode')"
check "within the 4 hours promised: $restore_seconds s here" true "$([ "$restore_seconds" -lt 14400 ] && echo true || echo false)"

section "the customers' server, archiving to the second site under a prefix and a key of its own"
data_admin_password="$(random)"
data_walg=(-e WALG_S3_PREFIX=s3://ff-backups/data-db -e AWS_ENDPOINT=http://site:8333 -e AWS_REGION=us-east-1 -e AWS_S3_FORCE_PATH_STYLE=true
  -e AWS_ACCESS_KEY_ID="$s3_key" -e AWS_SECRET_ACCESS_KEY="$s3_secret" -e WALG_LIBSODIUM_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  -e WALG_LIBSODIUM_KEY_TRANSFORM=hex -e WALG_COMPRESSION_METHOD=zstd -e PGHOST=/var/run/postgresql)
docker run -d --name "$prefix-data" --network "$network" --network-alias data -e POSTGRES_PASSWORD="$(random)" -e FF_DATA_DB_ARCHIVE=on \
  -e FF_DATA_DB_TLS_NAMES=DNS:data -e FF_DATA_DB_ADMIN_PASSWORD="$data_admin_password" "${data_walg[@]}" \
  -v "$prefix-data-data:/var/lib/postgresql" ff-data-db:drill >/dev/null
# Its first start runs initdb/ on a server that listens on its socket only: TCP answers once that is done.
for _ in $(seq 1 90); do
  docker exec "$prefix-data" pg_isready -q -h 127.0.0.1 -U ff_admin -d postgres 2>/dev/null && break
  sleep 1
done
data_pgdata="$(docker exec "$prefix-data" printenv PGDATA)"
check "it archives every segment, at least every 5 minutes, and takes 200 sessions" "on wal-g wal-push %p 5min 200" \
  "$(psql_on "$prefix-data" postgres 'SHOW archive_mode') $(psql_on "$prefix-data" postgres 'SHOW archive_command') $(psql_on "$prefix-data" postgres 'SHOW archive_timeout') $(psql_on "$prefix-data" postgres 'SHOW max_connections')"
# make_database: a customer's database and its user, made by the backend's own code (PostgresDataServer) with its role
# on the server, over TLS, the certificate checked; prints the name and the password.
make_database() {
  docker run --rm --network "$network" -e ADMIN_PASSWORD="$data_admin_password" \
    -e DATA_CA="$(docker exec "$prefix-data" cat /var/lib/postgresql/tls/ca.crt)" ff-backend:drill node -e "
      const { PostgresDataServer } = require('./dist/databases/data-server');
      const { scramVerifier } = require('./dist/databases/scram');
      const { newServerName, newPassword } = require('./dist/databases/database-names');
      const server = new PostgresDataServer({ host: 'data', port: 5432, adminHost: 'data', adminUser: 'ff_admin',
        adminPassword: process.env.ADMIN_PASSWORD, cidrs: [], ca: process.env.DATA_CA });
      const name = newServerName(), password = newPassword();
      server.create(name, scramVerifier(password), 10).then(() => console.log(name, password)).finally(() => server.close())
        .catch((error) => { console.error(error.message); process.exitCode = 1; });"
}
# as_customer <name> <password> <sql>: as a customer's app connects, over TLS, the server's certificate checked.
as_customer() {
  docker exec "$prefix-data" psql "postgresql://$1:$2@data:5432/$1?sslmode=verify-full&sslrootcert=/var/lib/postgresql/tls/ca.crt" \
    -v ON_ERROR_STOP=1 -XqtA -c "$3"
}
made="$(make_database)" || fail "the backend's code could not make a database"
read -r shop shop_password <<<"$made"
made="$(make_database)" || fail "the backend's code could not make a database"
read -r other other_password <<<"$made"
marker="drill-$(random | tr -dc 'a-z0-9' | cut -c1-10)"
as_customer "$shop" "$shop_password" "CREATE EXTENSION pgcrypto;
  CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, item text NOT NULL, made text NOT NULL);
  INSERT INTO orders (item, made) SELECT '$marker-' || g, 'before' FROM generate_series(1, 100) g" >/dev/null
as_customer "$other" "$other_password" "CREATE TABLE notes (body text); INSERT INTO notes VALUES ('$marker-other')" >/dev/null
check "two customers' databases, made by the backend's code, written by their own users" "100 1" \
  "$(as_customer "$shop" "$shop_password" 'SELECT count(*) FROM orders') $(as_customer "$other" "$other_password" 'SELECT count(*) FROM notes')"
docker exec "${data_walg[@]}" "$prefix-data" wal-g backup-push "$data_pgdata" >"$work/data-backup.log" 2>&1 ||
  { tail -20 "$work/data-backup.log"; fail "the customers' server's base backup failed"; }
sleep 1
data_target="$(psql_on "$prefix-data" postgres "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 1
# After the target, the customer's app writes 50 orders, then deletes the 100 before them by mistake.
as_customer "$shop" "$shop_password" "INSERT INTO orders (item, made) SELECT '$marker-' || g, 'after' FROM generate_series(101, 150) g;
  DELETE FROM orders WHERE made = 'before'" >/dev/null
psql_on "$prefix-data" postgres 'SELECT pg_switch_wal()' >/dev/null
for _ in $(seq 1 60); do
  [ "$(psql_on "$prefix-data" postgres "SELECT last_archived_wal >= pg_walfile_name(pg_current_wal_lsn() - 1) FROM pg_stat_archiver")" = t ] && break
  sleep 1
done
check "a base backup at the second site, the last segment archived, none failing" "1 t 0" \
  "$(docker exec "${data_walg[@]}" "$prefix-data" wal-g backup-list 2>/dev/null | tail -n +2 | wc -l | tr -d ' ') $(psql_on "$prefix-data" postgres "SELECT last_archived_wal >= pg_walfile_name(pg_current_wal_lsn() - 1) FROM pg_stat_archiver") $(psql_on "$prefix-data" postgres 'SELECT failed_count FROM pg_stat_archiver')"
rclone cat --max-size 100M --include '*' site:ff-backups/data-db >"$work/data-site.bin" 2>/dev/null || true
check "the second site holds none of their rows readable without the key" "0 true" \
  "$(grep -ac "$marker" "$work/data-site.bin" || true) $([ -s "$work/data-site.bin" ] && echo true || echo false)"

section "one customer's database, to the target time ($data_target), as the runbook brings it back"
one_started="$(date +%s)"
docker run --rm "${data_walg[@]}" --network "$network" -v "$prefix-scratch-data:/var/lib/postgresql" --entrypoint bash ff-data-db:drill -c "
  mkdir -p '$data_pgdata' && chmod 700 '$data_pgdata' && wal-g backup-fetch '$data_pgdata' LATEST && touch '$data_pgdata/recovery.signal' &&
  printf \"recovery_target_time = '%s'\nrecovery_target_action = 'promote'\n\" '$data_target' >>'$data_pgdata/postgresql.auto.conf'" \
  >"$work/data-fetch.log" 2>&1 || { tail -20 "$work/data-fetch.log"; fail "the customers' server's base backup could not be fetched"; }
# The scratch server holds every customer's data as of then: its socket only. It archives nothing, or its new timeline
# would reach the second site beside the server's, and a later restore of the server would follow it. Its certificate
# isn't in the backup, and its socket needs none.
docker run -d --name "$prefix-scratch" --network "$network" "${data_walg[@]}" -v "$prefix-scratch-data:/var/lib/postgresql" ff-data-db:drill \
  postgres -c listen_addresses= -c ssl=off -c archive_mode=off >/dev/null
for _ in $(seq 1 120); do
  [ "$(psql_on "$prefix-scratch" postgres 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ] && break
  sleep 1
done
check "the whole server, restored elsewhere from the second site, opens at the target: the server's 200 sessions, its socket only, archiving nothing" \
  "f 200 [] off" \
  "$(psql_on "$prefix-scratch" postgres 'SELECT pg_is_in_recovery()') $(psql_on "$prefix-scratch" postgres 'SHOW max_connections') [$(psql_on "$prefix-scratch" postgres 'SHOW listen_addresses')] $(psql_on "$prefix-scratch" postgres 'SHOW archive_mode')"
# The account's new database, made as any other: in production by the customer, in the console or with ff db create.
made="$(make_database)" || fail "the backend's code could not make a database"
read -r copy copy_password <<<"$made"
docker exec "$prefix-scratch" pg_dump -U postgres --format=custom -d "$shop" >"$work/one.dump"
docker exec -i "$prefix-data" pg_restore -U postgres --role="$copy" --no-owner --no-acl --exit-on-error -d "$copy" <"$work/one.dump"
one_seconds=$(($(date +%s) - one_started))
check "the copy, a new database of the account's: the 100 orders deleted after the target back, none of the 50 written after it" "100 0" \
  "$(as_customer "$copy" "$copy_password" "SELECT count(*) FROM orders WHERE made = 'before'") $(as_customer "$copy" "$copy_password" "SELECT count(*) FROM orders WHERE made = 'after'")"
check "  ... its table and extension its new user's, as if it had made them, and the extension working" \
  "$copy $copy:pgcrypto 64" \
  "$(as_customer "$copy" "$copy_password" "SELECT tableowner FROM pg_tables WHERE tablename = 'orders'") $(as_customer "$copy" "$copy_password" "SELECT extowner::regrole || ':' || extname FROM pg_extension WHERE extname = 'pgcrypto'") $(as_customer "$copy" "$copy_password" "SELECT length(encode(digest(item, 'sha256'), 'hex')) FROM orders LIMIT 1")"
check "the live databases untouched: the customer's as its app left it, the other customer's as ever" "50 1" \
  "$(as_customer "$shop" "$shop_password" 'SELECT count(*) FROM orders') $(as_customer "$other" "$other_password" 'SELECT count(*) FROM notes')"
check "the second site got nothing from the scratch server: no timeline beside the server's" 0 \
  "$(rclone lsf -R site:ff-backups/data-db | grep -c 'history' || true)"
docker rm -f "$prefix-scratch" >/dev/null
docker volume rm "$prefix-scratch-data" >/dev/null
echo "  one database back in $one_seconds s, from the fetch to the copy; the scratch server deleted"

section "the bucket's legal records"
mkdir -p "$work/records/invoices/2026" "$work/records/withholding-certificates"
head -c 40000 /dev/urandom >"$work/records/invoices/2026/FAC-2026-000001.pdf"
head -c 30000 /dev/urandom >"$work/records/withholding-certificates/payment-1.pdf"
rclone copy /work/records primary:functions >/dev/null
# The mirror the cluster runs hourly (deploy/k8s/backup/mirror.sh), the same script, in rclone's image.
cp "$repo/deploy/k8s/backup/mirror.sh" "$work/mirror.sh"
# mirror [-e VAR=value...]: one run of it, with these settings too; its exit status.
mirror() {
  rclone_env=(-e PRIMARY_BUCKET=functions -e SITE_BUCKET=ff-backups "$@")
  local status=0
  rclone_run sh /work/mirror.sh || status=$?
  rclone_env=()
  return "$status"
}
mirror >/dev/null
check "every record copied to the second site, byte for byte" 0 \
  "$(rclone check primary:functions/invoices site:ff-backups/s3/invoices --one-way >/dev/null 2>&1 && rclone check primary:functions/withholding-certificates site:ff-backups/s3/withholding-certificates --one-way >/dev/null 2>&1; echo $?)"
rclone deletefile primary:functions/invoices/2026/FAC-2026-000001.pdf >/dev/null
sleep 1 # a run of its own, by the second
mirror >/dev/null
check "an invoice lost on the primary stays at the second site" 1 "$(rclone lsf site:ff-backups/s3/invoices/2026 | grep -c FAC-2026-000001.pdf)"
rclone copy site:ff-backups/s3/invoices primary:functions/invoices >/dev/null
rclone copy primary:functions/invoices/2026/FAC-2026-000001.pdf /work/restored >/dev/null
check "and comes back from it, byte for byte" "$(sha256sum <"$work/records/invoices/2026/FAC-2026-000001.pdf")" "$(sha256sum <"$work/restored/FAC-2026-000001.pdf")"

section "functions' packages"
mkdir -p "$work/packages/packages/111111111111" "$work/packages/packages/222222222222"
for zip in 111111111111/a 111111111111/b 111111111111/c 222222222222/d; do head -c 20000 /dev/urandom >"$work/packages/packages/$zip.zip"; done
rclone copy /work/packages primary:functions >/dev/null
# Deleted 40 days ago by an earlier run, and kept aside since: due to go.
rclone copyto /work/packages/packages/222222222222/d.zip site:ff-backups/s3-deleted/2020-01-01T000000/packages/222222222222/old.zip >/dev/null
sleep 1
mirror >/dev/null
check "every package copied to the second site, byte for byte" 0 "$(rclone check primary:functions/packages site:ff-backups/s3/packages >/dev/null 2>&1; echo $?)"
check "what was set aside 30 days ago or more is gone from the second site" 0 "$(rclone lsf -R site:ff-backups/s3-deleted | grep -c old.zip)"
# The purge of unused packages deletes one, as FF does an hour after its last use.
rclone deletefile primary:functions/packages/111111111111/a.zip >/dev/null
sleep 1
mirror >/dev/null
check "a package FF deleted goes from the copy, set aside for 30 days first" "0 1" \
  "$(rclone lsf -R site:ff-backups/s3/packages | grep -c a.zip) $(rclone lsf -R site:ff-backups/s3-deleted | grep -c 'packages/111111111111/a.zip')"
# The bucket loses them all: a run must not take them from the copy.
rclone purge primary:functions/packages >/dev/null
sleep 1
refusal="$(mirror -e PACKAGES_MAX_DELETE=1 2>&1 >/dev/null)" && fail "the mirror synced an empty bucket"
check "a bucket that lost every package deletes none at the second site: the run stops, saying why" "3 true" \
  "$(rclone lsf -R --files-only site:ff-backups/s3/packages | wc -l | tr -d ' ') $(grep -q "this run would delete 3 of the second site's 3" <<<"$refusal" && echo true || echo false)"
rclone copy site:ff-backups/s3/packages primary:functions/packages >/dev/null
check "and they come back from it, byte for byte" 0 "$(rclone check site:ff-backups/s3/packages primary:functions/packages >/dev/null 2>&1; echo $?)"
sleep 1
check "the next run finds nothing to delete" "packages copied to the second site, 0 deleted there" "$(mirror | grep -o 'packages copied to the second site, [0-9]* deleted there')"

# Before the record: a drill with a failed check fails here, and is never recorded as passed.
checks_done "backup drill"
echo "backup drill: restored to the target in $restore_seconds s, one customer's database in $one_seconds s"
if $record; then
  printf '| %s | %s | PostgreSQL 15.19 with WAL-G 3.0.9, both databases to a target time; one customer'"'"'s database from PostgreSQL 18.6 with WAL-G 3.0.9 to a target time; the legal records and the packages with rclone 1.75.1 | %s s; one database %s s | %s checks passed |\n' \
    "$(date -u +%Y-%m-%d)" "$(git -C "$repo" rev-parse --short HEAD)" "$restore_seconds" "$one_seconds" "$passed" >>"$repo/docs/backup-drills.md"
  echo "recorded in docs/backup-drills.md"
fi

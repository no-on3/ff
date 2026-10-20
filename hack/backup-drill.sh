#!/usr/bin/env bash
# The restore drill (deploy/backup/README.md): FF's database and Keycloak's, and the bucket's legal records,
# backed up to a second site and restored, on Docker alone, in a few minutes. Monthly, and after any change to
# the backups; --record adds its outcome to docs/backup-drills.md.
#   1. A primary S3 (FF's bucket) and a second site's S3, each a SeaweedFS of its own.
#   2. The reference PostgreSQL (deploy/backup/postgres-walg), FF's schema made by its migrations (from the
#      backend's image), and Keycloak's database beside it; WAL archived to the second site by WAL-G, encrypted.
#   3. A base backup; then rows written, the target time noted, and rows written after it.
#   4. A new server restored from the second site to the target time: what came before is there, what came after
#      isn't, in both databases; the ledger still balanced; the time it took, against the 4 hours promised.
#   5. The invoices and withholding certificates copied to the second site with rclone, one lost on the primary,
#      and copied back, byte for byte.
#   hack/backup-drill.sh [--record]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
record=false
[ "${1:-}" = "--record" ] && record=true
prefix="ff-drill-$$"
network="$prefix"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$prefix-site" "$prefix-s3" "$prefix-primary" "$prefix-restored" >/dev/null 2>&1 || true
  docker volume rm "$prefix-primary-data" "$prefix-restored-data" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
passed=0
fail() { echo "  FAIL $1" >&2; exit 1; }
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else fail "$1 (expected '$2', got '$3')"; fi
}
random() { head -c 18 /dev/urandom | base64 | tr -d '/+=\n'; }
"$repo/hack/check-resources.sh"

echo "== images"
docker build -q -t ff-postgres-walg:drill "$repo/deploy/backup/postgres-walg" >/dev/null
docker build -q -t ff-backend:drill "$repo/BE" >/dev/null
echo "  ff-postgres-walg (PostgreSQL 15.19, WAL-G 3.0.9) and ff-backend built"

echo "== two sites"
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

echo "== the primary PostgreSQL, archiving to the second site"
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

echo "== a base backup, then rows before and after the target time"
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

echo "== the restore, to the target time ($target)"
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

echo "== the bucket's legal records"
mkdir -p "$work/records/invoices/2026" "$work/records/withholding-certificates"
head -c 40000 /dev/urandom >"$work/records/invoices/2026/FAC-2026-000001.pdf"
head -c 30000 /dev/urandom >"$work/records/withholding-certificates/payment-1.pdf"
rclone copy /work/records primary:functions >/dev/null
# The mirror the cluster runs hourly (deploy/k8s/backup/mirror.sh), the same script, in rclone's image.
cp "$repo/deploy/k8s/backup/mirror.sh" "$work/mirror.sh"
mirror() {
  rclone_env=(-e PRIMARY_BUCKET=functions -e SITE_BUCKET=ff-backups)
  rclone_run sh /work/mirror.sh
  rclone_env=()
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

echo "backup drill: $passed checks passed; restored to the target in $restore_seconds s"
if $record; then
  printf '| %s | %s | PostgreSQL 15.19 with WAL-G 3.0.9, both databases to a target time; the legal records with rclone 1.75.1 | %s s | %s checks passed |\n' \
    "$(date -u +%Y-%m-%d)" "$(git -C "$repo" rev-parse --short HEAD)" "$restore_seconds" "$passed" >>"$repo/docs/backup-drills.md"
  echo "recorded in docs/backup-drills.md"
fi

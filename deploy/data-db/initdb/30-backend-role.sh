#!/usr/bin/env bash
# Run once, when the server is first made: the backend's role (ADR 0008). It makes databases and their users, never a
# superuser; it reads every database's size and sessions (pg_read_all_stats) and may end a customer's sessions
# (pg_signal_backend). Its password comes as FF_DATA_DB_ADMIN_VERIFIER, a SCRAM verifier made elsewhere, such as by
# psql's \password (production), or as FF_DATA_DB_ADMIN_PASSWORD (development), which the server turns into one.
set -euo pipefail
secret="${FF_DATA_DB_ADMIN_VERIFIER:-${FF_DATA_DB_ADMIN_PASSWORD:-}}"
if [ -z "$secret" ]; then
  echo "neither FF_DATA_DB_ADMIN_VERIFIER nor FF_DATA_DB_ADMIN_PASSWORD is set: the backend's role, ff_admin, is not made" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v secret="$secret" <<'SQL'
CREATE ROLE ff_admin LOGIN CREATEDB CREATEROLE PASSWORD :'secret';
GRANT pg_read_all_stats, pg_signal_backend TO ff_admin;
SQL

#!/usr/bin/env bash
# Run once, when the server is first made: its configuration includes the data server's settings, and WAL-G's
# archiving when FF_DATA_DB_ARCHIVE=on (production's, with walg.env's settings in the server's environment).
set -euo pipefail
echo "include '/etc/postgresql/postgresql.data.conf'" >>"$PGDATA/postgresql.conf"
if [ "${FF_DATA_DB_ARCHIVE:-off}" = on ]; then
  echo "include '/etc/postgresql/postgresql.archive.conf'" >>"$PGDATA/postgresql.conf"
fi

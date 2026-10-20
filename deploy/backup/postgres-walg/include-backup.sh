#!/usr/bin/env bash
# Run once, when the database is first made: the server's configuration includes the WAL archiving's.
set -euo pipefail
echo "include '/etc/postgresql/postgresql.backup.conf'" >>"$PGDATA/postgresql.conf"

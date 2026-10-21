# Backups and restore

What FF must never lose is money and law (client-readiness plan, P-61):
- the usage records, the ledger, the invoices' rows, in FF's database;
- the logins, in Keycloak's;
- the issued invoices' PDFs and the withholding certificates, in the S3 bucket (`invoices/`, `withholding-certificates/`).

**The targets:** at most 15 minutes of data lost when the database's server fails (recovery point), and FF serving again within 4 hours (recovery time). A restore drill proves both every month: [`docs/backup-drills.md`](../../docs/backup-drills.md) records each.

**A second site:** each backup lives at another provider, or at least in another region, than what it backs up. A key that only FF holds encrypts it before it leaves.

## The databases

FF's database and Keycloak's are two databases of one PostgreSQL server (D13). Point-in-time recovery restores the whole server to any second of the window, both databases together.

**A managed PostgreSQL** has its provider's point-in-time recovery: turn it on, with a window of at least 30 days. If the provider can copy the backups to another region, turn that on too, or add a nightly `pg_dump` of both databases to the second site's bucket. The monthly drill then restores the provider's way, to a new server, and runs the checks of `hack/backup-drill.sh` against it.

**A server of FF's own** archives its WAL with WAL-G, as `postgres-walg/` shows:
- `Dockerfile`: PostgreSQL 15.19 with WAL-G 3.0.9, its checksum checked. It starts as `postgres` (999), never as root, so it has no `gosu`; WAL-G's binary has advisories that `.trivyignore.yaml` accepts until 2026-11-20, for a client of the second site alone;
- `postgresql.backup.conf`: every WAL segment shipped when it is full, and at least every 5 minutes (`archive_timeout = 300`): the recovery point is never older than that;
- `walg.env.example`: the second site, its keys, and `WALG_LIBSODIUM_KEY`, 32 random bytes (hex) that encrypt every backup;
- `crontab.example`: a base backup every night; every Sunday, the last 35 kept with their WAL, so any second of the last 30 days can be restored.

The encryption key is kept apart from both the server and the second site: in FF's password manager, and printed in the safe. Without it nothing can be restored, and with it alone nobody can reach the backups. The second site holds no customer data in clear. WAL-G's own metadata names the databases and their tables, which FF's repository shows anyway.

**Functions' variables and secrets** are in FF's database, sealed with the keys of the Secret `ff-encryption-keys` (`FF_ENCRYPTION_KEYS_FILE`, `deploy/k8s/README.md`). A restored database is useless for them without those keys: keep the keys file with the backups' own key, in FF's password manager and in the safe, and add each new key there the day it goes into the Secret. The backups themselves never hold a value in clear: the rows are sealed before PostgreSQL sees them.

PostgreSQL keeps a segment it couldn't ship and tries again. While the second site is away, `pg_wal` grows: the operator's metrics alert on the database's disk (`FFDatabaseDiskFilling`, ADR 0006).

## The legal records

`deploy/k8s/backup/` is a CronJob in `ff-system`, hourly, running `mirror.sh` with rclone 1.75.1. It copies the bucket's `invoices/` and `withholding-certificates/` to the second site:
- a copy, never a sync: a file gone from the bucket stays at the site;
- a file replaced keeps its old version under `s3-replaced/<run>/`.

It needs the Secret `ff-backup-s3`: `RCLONE_CONFIG_PRIMARY_TYPE=s3` and the rest of each site's rclone settings (`_PROVIDER`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`), then `PRIMARY_BUCKET` and `SITE_BUCKET`. Give the second site's bucket versioning, or object lock, where the provider offers it.

How long to keep them is the accountant's answer (section 9, question 5); until it comes, keep everything.

## Restoring

1. **Stop the writers:** scale the backend to 0 (`kubectl -n ff-system scale deployment/ff-backend --replicas=0`) and Keycloak with it, so nothing writes to the server being replaced.
2. **The databases.** On a new server from the same image and settings:
   - `wal-g backup-fetch "$PGDATA" LATEST`;
   - `touch "$PGDATA/recovery.signal"`;
   - in `postgresql.auto.conf`, `recovery_target_time = '<the moment>'` and `recovery_target_action = 'promote'`, or no target at all for the latest;
   - start it. It replays the WAL and opens.

   A managed PostgreSQL restores the provider's way, to a new instance.
3. **Point the platform at it:** `DB_HOST` in the backend's settings and `KC_DB_URL_HOST` in Keycloak's, then `deploy/k8s/platform/deploy.sh <overlay>`. Its migrations Job finds none pending, or runs those the restored schema lacks.
4. **The legal records,** if the bucket was lost: `rclone copy site:<bucket>/s3/<prefix> primary:<bucket>/<prefix>` for each prefix.
5. **Check** before opening the doors:
   - `npm run billing:reconcile` agrees with the restored usage;
   - the admin dashboard's Overview shows what you expect;
   - `/readyz` answers ready.

   Then tell the customers what, if anything, was lost: at most the minutes since the last segment.

## The drill

`hack/backup-drill.sh` runs the whole of it on Docker alone, in a few minutes, with an S3 for the bucket and another for the second site:
- the reference server, FF's schema made by its migrations, and Keycloak's database;
- a base backup, rows before and after a target time, and the last segment shipped;
- a check that the second site holds no row readable without the key;
- a new server restored from the second site to the target time: the rows before it there, those after it not, in both databases, the ledger still balanced, and the time it took;
- the legal records copied by the cluster's own `mirror.sh`, one lost and brought back byte for byte.

`--record` adds the outcome to `docs/backup-drills.md`. Run it monthly, and after any change here. A drill of the production setup, the provider's way or the server's, gets its own line there too.

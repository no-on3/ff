# Backups and restore

What FF must never lose is money and law (client-readiness plan, P-61):
- the usage records, the ledger, the invoices' rows, in FF's database;
- the logins, in Keycloak's;
- the issued invoices' PDFs and the withholding certificates, in the S3 bucket (`invoices/`, `withholding-certificates/`).

Nor its customers' code: the packages their functions run, in the bucket (`packages/`), which the code registry's images are made of again when it loses them. Inline code is in FF's database too.

Nor its customers' databases, on a server of their own ([`deploy/data-db`](../data-db/README.md)): any second of the last 7 days can be brought back, as AWS RDS keeps them by default, the whole server or one database.

Customers' buckets are not copied to the second site: the store's own redundancy keeps them, as S3's does, and the getting-started guide tells customers so, and how to keep a copy of their own ([decision 11](../../docs/decisions.md)). A lost store loses them; whether FF copies them is decided again before customers keep important files on FF.

**The targets:** at most 15 minutes of data lost when the database's server fails (recovery point), and FF serving again within 4 hours (recovery time); the same for the customers' server. A restore drill proves both every month: [`docs/backup-drills.md`](../../docs/backup-drills.md) records each.

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

## Customers' databases

The server of customers' databases ([`deploy/data-db`](../data-db/README.md)) archives its WAL with WAL-G as FF's own server does, from its own image:
- `FF_DATA_DB_ARCHIVE=on` at its first start includes `postgresql.archive.conf`: every segment shipped when it is full, and at least every 5 minutes;
- WAL-G's settings as `postgres-walg/walg.env.example` has them, with a prefix of its own on the second site (`s3://ff-backups/data-db`) and a key of its own (`WALG_LIBSODIUM_KEY`), kept as FF's is, in FF's password manager and in the safe: FF's key opens none of the customers' backups, nor theirs FF's;
- `deploy/data-db/crontab.example`: a base backup every night, then the last 8 kept with their WAL, so that any second of the last 7 days can be restored.

Customers' passwords are SCRAM verifiers in the server's catalog: they come back with it, and the connection strings customers hold work on a restored server. Its certificate is not in the backups (`/var/lib/postgresql/tls/`, beside the data): keep its key with the server's other secrets, or get a new certificate for its name.

**The whole server lost:** as FF's own, on a new machine from the same image: `wal-g backup-fetch "$PGDATA" LATEST`, `touch "$PGDATA/recovery.signal"`, the certificate in `/var/lib/postgresql/tls/`, then start it; it replays the WAL and opens. Give it the old machine's address, as a failover IP moves: functions' network policies name that address (`FF_DATA_DB_CIDRS`), and each account's is written again only at its next deploy, plan or egress change. Connection strings name the server by its name (`db.ffunc.tn`), which DNS then points at it.

### One customer's database, from a point in time

As RDS restores one: to a new database, which the customer's app then uses, the database as it is now staying until they delete it. The whole server is restored elsewhere to the moment, then that one database copied into the new one. The drill does every step: 9 s from the fetch to the copy, for its small server.

1. **The request:** from an owner of the account, from the e-mail address FF knows them by: which database, by its name in the account, and the moment, in UTC, within the last 7 days. In the admin app, the account's page lists its databases: check that it has one of that name, and note its name on the server, `ff_` and 24 characters.
2. **The new database:** the customer makes it, in the console or with `ff db create <name> --secret-for <function>`, which also gives its connection string to the functions named, and notes its name on the server too (the console's database page, `ff db get`). The beta's plan allows one database: for as long as they need both, move the account to a plan that allows two, in the admin app.
3. **The scratch server,** on a machine with disk for the whole server, from the same image and WAL-G's settings as the server's, its prefix and key:
   - `wal-g backup-list --detail`: the last base backup that finished before the moment, then `wal-g backup-fetch "$PGDATA" <its name>`;
   - `touch "$PGDATA/recovery.signal"`, and in `postgresql.auto.conf`, `recovery_target_time = '<the moment>+00'` and `recovery_target_action = 'promote'`;
   - start it with `postgres -c listen_addresses= -c ssl=off -c archive_mode=off`: its socket only, since it holds every customer's data as of then; no TLS, which its socket doesn't need and for which it has no certificate; and **no archiving:** its own timeline would reach the second site beside the server's, and a later restore of the server could follow it. The image's settings give it the server's `max_connections`: with fewer, PostgreSQL aborts the recovery;
   - it replays the WAL to the moment and opens: `SELECT pg_is_in_recovery()` says `f`.
4. **The copy,** from the scratch server to the new database, each over its socket as the superuser, with no customer's password:

   ```bash
   docker exec <scratch> pg_dump -U postgres --format=custom -d ff_<the database> >one.dump
   docker exec -i <server> pg_restore -U postgres --role=ff_<the new one> --no-owner --no-acl --exit-on-error -d ff_<the new one> <one.dump
   ```

   `--role` restores as the new database's user: its tables and extensions are its own, as if it had made them. Between two machines, pipe one into the other over SSH rather than leave the file anywhere.
5. **Delete the scratch server, its disk and `one.dump`:** they hold every customer's data, or that one's.
6. **Tell the customer:** the new database holds their data as of the moment; their functions use it once their `DATABASE_URL` is its string, which `--secret-for` set; the old one stays, billed with the new, until they delete it. Then put the account back on its plan.

## The legal records and the packages

`deploy/k8s/backup/` is a CronJob in `ff-system`, hourly, running `mirror.sh` with rclone 1.75.1. It copies the bucket's `invoices/` and `withholding-certificates/` to the second site:
- a copy, never a sync: a file gone from the bucket stays at the site;
- a file replaced keeps its old version under `s3-replaced/<run>/`.

Then it syncs `packages/`, the zips of functions' packages, the uploaded ones and those the backend makes of inline code:
- what FF deletes there, a package no function has named for an hour or a closed account's, goes from the site too: set aside under `s3-deleted/<run>/` for 30 days first, about as long as the database's point-in-time recovery keeps what was deleted;
- a run that would delete more than half of the site's packages, and more than 10, deletes nothing and fails, saying how many: a bucket lost, or replaced by an empty one, never empties the copy. Its Job's failed pod raises `FFPlatformPodNotRunning`. Look at the bucket; if FF did delete them, as when a large account closed, give the CronJob that number for one run (`kubectl -n ff-system set env cronjob/ff-records-mirror PACKAGES_MAX_DELETE=<n>`), and take it away after (`… PACKAGES_MAX_DELETE-`).

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
4. **The legal records and the packages,** if the bucket was lost: `rclone copy site:<bucket>/s3/<prefix> primary:<bucket>/<prefix>` for each prefix, `invoices`, `withholding-certificates` and `packages`. Then restart the backend (`kubectl -n ff-system rollout restart deployment/ff-backend`): at its start it makes again every code image the registry lacks, and rolls out the functions whose pods mounted one ([`deploy/k8s`](../k8s/README.md), "The code registry").
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
- the customers' server, archiving under its own prefix and key: two customers' databases made by the backend's own code, rows written and deleted by mistake after a target time; the server restored elsewhere to that time, archiving nothing, and that one database copied into a new one of the account's, as the runbook above does: the rows deleted back, those written after it not, owned by its new user, the live databases untouched, nothing from the scratch server at the second site;
- the legal records copied by the cluster's own `mirror.sh`, one lost and brought back byte for byte;
- functions' packages synced by the same script: one FF deleted, gone from the copy and set aside, and what was set aside 30 days ago gone; a bucket that lost them all, deleting nothing at the site; and all brought back byte for byte.

`--record` adds the outcome to `docs/backup-drills.md`. Run it monthly, and after any change here. A drill of the production setup, the provider's way or the server's, gets its own line there too.

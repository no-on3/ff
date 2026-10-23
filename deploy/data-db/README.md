# The server of customers' databases

Customers' PostgreSQL databases live on a server of their own, apart from FF's ([ADR 0008](../../docs/adr/0008-customer-databases.md)): a customer's heavy queries or full disk never reach FF's control plane, and the server has its own backups and can move to bigger hardware alone. The backend makes each database and its user there with a role of its own, never a superuser. This folder is the reference server, as [`deploy/backup/postgres-walg`](../backup/postgres-walg) is for FF's own.

## The image

`docker build -t ff-data-db deploy/data-db`:
- **PostgreSQL 18.6,** the newest major version AWS RDS runs: FF never runs a newer one, so that every database can move to RDS. 19 comes once RDS offers it.
- **WAL-G 3.0.9,** FF's version, its checksum checked, measured on PostgreSQL 18 by the spike (`backup-push`, `wal-push`, `backup-fetch`, `wal-fetch`).
- **`postgresql.data.conf`,** which the server's own configuration includes from its first start: TLS only (1.2 at least), SCRAM, 200 connections, logins logged (the users are opaque names), and a session's temporary files limited to 5 GB, a setting customers can't change.
- **`pg_hba.conf`,** who may log in where, first match winning: the superuser over the server's socket only; the backend's role, `ff_admin`, to the maintenance database only; each customer's user to its namesake database only; nothing without TLS.
- **`initdb/`,** run at the first start: the settings included; the certificate checked, or made in development; the backend's role made.
- It starts as `postgres` (999), never as root: the image has no `gosu`.

## Installing it

1. **A machine of its own,** in Tunisia as FF's others (the [decision log](../../docs/decisions.md), 21), with a disk of its own for `/var/lib/postgresql`, and a firewall: port 5432 from the cluster's nodes, the backend, and, for developers' laptops (the step-2 plan's D14), the internet. Nothing else.
2. **Its name,** such as `db.ffunc.tn`, in DNS: connection strings name it, and its certificate does.
3. **Its certificate,** for that name, from a public CA (Let's Encrypt, by DNS or on port 80), in `/var/lib/postgresql/tls/server.crt` and `server.key`, owned by 999, the key `0600`. Every driver then connects with `sslmode=require`, and node-postgres, which checks the certificate with it, finds it trusted. Renew it before it expires and reload the server (`pg_ctl reload`, or `SIGHUP`): PostgreSQL reads the files again. A CA of the operator's works too, as RDS's own: then give its certificate to the backend, `FF_DATA_DB_CA_FILE`, which also hands it to functions' pods.
4. **The backend's role's password,** 32 random bytes, kept in FF's password manager: make its SCRAM verifier with `node deploy/data-db/scram-verifier.mjs <password>`, and start the server the first time with it as `FF_DATA_DB_ADMIN_VERIFIER`: the password itself never reaches the server. To change it later, `psql`'s `\password ff_admin` sends the server a verifier too. `FF_DATA_DB_ARCHIVE=on` and WAL-G's settings (`deploy/backup/postgres-walg/walg.env.example`, a prefix of its own on the second site, such as `s3://ff-backups/data-db`) turn the archiving on.
5. **Narrow `ff_admin`'s lines in `pg_hba.conf`** to the backend's addresses: in a cluster, its nodes'.
6. **The backend's settings** (`deploy/k8s/platform/backend.env`, the password in the Secret): `FF_DATA_DB_HOST` (the server's name), `FF_DATA_DB_ADMIN_HOST` if the backend reaches it at another address, `FF_DATA_DB_ADMIN_PASSWORD`, `FF_DATA_DB_CIDRS` (the addresses the server's name resolves to from the cluster: functions' NetworkPolicy opens port 5432 to them, whatever their account's internet access), and `FF_DATA_DB_CA_FILE` for a CA of the operator's. The backend checks them at its start.

## What the backend does there

With `ff_admin`, as ADR 0008 says and the spike measured:
- **A database:** its user, `ff_` and 24 random characters, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, with the plan's `CONNECTION LIMIT` and a password sent as a SCRAM verifier; the user granted to `ff_admin` `WITH INHERIT FALSE, SET TRUE`; the database of the same name, owned by the user; and, as its owner, `PUBLIC`'s rights on it revoked.
- **Every hour:** every database's size and sessions, in one query (250 ms for a thousand databases).
- **Past the plan's storage:** the user's sessions in its database start read-only, and those under way are ended; back under, the setting goes.
- **A suspended account:** its users can't log in, and their sessions end; reactivated, they log in again.
- **A closed account,** at its data deletion date: each database dropped as its owner, then its user.

## Watching it

The operator's monitoring (ADR 0006) gains the server: its disk, its connections against `max_connections`, its slowest statements (`log_min_duration_statement`, off by default: statements hold customers' data). A disk filling is the wall the read-only signal is not.

## Backups and restoring one database

As FF's own server: a base backup each night (`crontab.example`), every WAL segment within 5 minutes, encrypted with a key of its own, to the second site, kept 7 days as RDS keeps them by default. One customer's database comes back by restoring the whole server elsewhere to the moment asked, then copying that database into a new one of the account's: the runbook is [`deploy/backup`](../backup/README.md)'s "One customer's database, from a point in time", and the monthly drill (`hack/backup-drill.sh`) does it. The restored server needs the settings this one had, `max_connections` at least, or PostgreSQL aborts the recovery: run it from this image.

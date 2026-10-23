# ADR 0008: Customers' databases

| | |
|---|---|
| **Status** | Accepted: the [step-2 plan](../step-2-plan.md)'s D1 to D5, D12 to D14, and its choices for databases (its §9), confirmed by you on 2026-10-22; measured by V-01's spike on 2026-10-23 |
| **Date** | 2026-10-23 |
| **Implementation** | Step-2 plan: decisions D1 to D5, D10, D12 to D14; tasks V-02 to V-05 |
| **Related** | [Parent plan](../local-markets-and-aws-portability-plan.md) §6.7 (PostgreSQL rather than DynamoDB); [What to build next](../what-to-build-next.md) §5.1; the [client-readiness plan](../client-readiness-plan.md)'s D13 (FF's own PostgreSQL, outside the cluster); [`deploy/backup`](../../deploy/backup/README.md); the spike, [`hack/spikes/data-services`](../../hack/spikes/data-services/README.md) |

## Context

An app without a database can't keep anything, and every hosted PostgreSQL abroad needs a card. Customers get one from FF, as AWS RDS gives one: PostgreSQL itself, a version RDS runs, so that `pg_dump` and `pg_restore`, or logical replication, move it to RDS.

Many customers share one server at first. The questions the plan left to measure: how the server keeps customers apart when every user can read the catalog; what the backend may do there without being a superuser; how a function reaches the server with its account's internet access off, and nothing else private; what a database past its plan's storage does; what sampling every database's size costs; how one customer's database comes back from a point in time; and what the commonest drivers make of the connection string.

The spike ran all of it on PostgreSQL 18.6 (`postgres:18.6-bookworm`, with WAL-G 3.0.9, FF's version), beside the development cluster: **every check passed**, the measures below.

## Decision

### 1. A server of its own, PostgreSQL 18, outside the cluster
- **Apart from FF's own database:** a customer's heavy queries or full disk never reach FF's control plane, and it has its own backups, its own restores, and can move to bigger hardware alone. One server to start; a server per plan tier when the plans need it, each database placed on one (the `server` column).
- **The newest major version RDS runs,** 18 today (18.6 measured), never newer than RDS's: 19 once RDS offers it.
- **TLS required, SCRAM only,** and `pg_hba.conf`, first match winning:

  ```
  local    all       postgres              peer            # the superuser, on the server only
  hostssl  all       postgres  0.0.0.0/0   reject
  hostssl  postgres  ff_admin  <backend>   scram-sha-256   # the backend's role, to the maintenance database only
  hostssl  sameuser  all       0.0.0.0/0   scram-sha-256   # each customer's user, to its namesake database only
  host     all       all       0.0.0.0/0   reject          # nothing without TLS
  ```

  Measured: the backend's role without TLS, the superuser over TCP even with TLS, a customer's user in the other customer's database, in `postgres`, without TLS, with a wrong password: all refused.

### 2. The backend's role: no superuser
`ff_admin`: `LOGIN CREATEDB CREATEROLE`, and a member of two of PostgreSQL's predefined roles, `pg_read_all_stats` (every database's size and sessions) and `pg_signal_backend` (ending a customer's sessions). Two rules PostgreSQL 16 and later impose, both measured:
- **`CREATE DATABASE … OWNER <user>` needs the right to `SET ROLE` to that user.** `CREATEROLE` gives its creator the `ADMIN` option on the users it makes, not that: each user is granted to `ff_admin` `WITH INHERIT FALSE, SET TRUE`, so that the backend can act as it when it must, and never has its rights by default.
- **What only a database's owner may do is done as its owner,** through `SET ROLE`: `REVOKE ALL ON DATABASE … FROM PUBLIC` run by `ff_admin` itself changed nothing (PostgreSQL warns "no privileges could be revoked"), and `DROP DATABASE` is refused ("must be owner").

### 3. A database and its user
- **One user per database, its owner,** `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, with the plan's `CONNECTION LIMIT` (an eleventh connection refused at 10, measured), and `PUBLIC`'s rights on the database revoked by its owner.
- **Opaque names:** the user and its database are both `ff_` and 24 random hexadecimal characters. Every user reads `pg_database` and `pg_roles`: the spike's customer listed the other's database and user. The customer's own name for it is FF's to keep (`databases.name`). Another user's sessions show only `<insufficient privilege>` in `pg_stat_activity`.
- **What the owner may do:** its tables and schemas, and PostgreSQL's trusted extensions (`pgcrypto`, `citext`, `hstore`, `pg_trgm`, `uuid-ossp` measured; the others trusted since PostgreSQL 13 likewise). Refused, measured: `dblink`, `postgres_fdw`, `COPY … TO PROGRAM`, `pg_read_file`, another database, another role.
- **The password:** 32 random bytes, made by the backend and shown once, sent to the server as a SCRAM verifier the backend computes (`SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>`, from PBKDF2-SHA-256): with every DDL statement in the server's log, the log held the verifiers and never a password.
- **Made in a fifth of a second:** with PostgreSQL's default strategy (`WAL_LOG`: the template copied through the WAL, no checkpoint), 178 ms each, ten in a row; the other strategy, `FILE_COPY`, makes a checkpoint each time, 1.1 s each with a thousand databases on the server. The backend uses the default.

### 4. Functions reach it, whatever their account's internet access
- **A NetworkPolicy rule of its own** in every tenant's `ff-default-deny`: egress to the server's addresses (`FF_DATA_DB_CIDRS`) on port 5432, nothing else. NetworkPolicy rules add up, so the private ranges the internet rule excludes don't cancel it. Measured from a tenant pod under gVisor, its account's internet access off: the server answered; a PostgreSQL next to it on the same network that trusts everyone didn't, nor another port of the server, nor the internet; with the rule taken away, the server didn't either.
- **The server sees the cluster's node,** not the pod: the cluster masquerades what leaves it (measured, 10.199.0.2, the node's address on the server's network). So `pg_hba.conf`'s addresses for the cluster are its nodes', and between accounts the wall is the user, its password, SCRAM and TLS.
- **Each tenant's policy gets the rule** at the account's next deploy, at a plan or egress change, and when the account makes a database, which applies it at once.

### 5. Past the plan's storage: a signal, then the bill
PostgreSQL has no limit on a database's size, and a customer can take back any setting of its own sessions. So, as the plan says (D5), confirmed:
- **The read-only signal is the user's setting in its database,** `ALTER ROLE <user> IN DATABASE <db> SET default_transaction_read_only = on`, which the backend's role may set as the user's admin. `ALTER DATABASE … SET` needs the owner (refused, measured). Its new sessions read, and a write answers `cannot execute INSERT in a read-only transaction`, SQLSTATE 25006, as an app meets it.
- **Its sessions under way are ended** when the signal starts (`pg_terminate_backend`, through `pg_signal_backend`), so that a pool's connections come back read-only too.
- **The customer can clean up:** a session sets `default_transaction_read_only = off`, or begins `READ WRITE`, and deletes. It can even take the setting away, from a read-write session (from a read-only one, `ALTER ROLE` is refused): the hourly sample sets it again while the database is over, so it stays a signal, as the plan meant, and the storage above the plan is billed.
- **Back under the plan,** the setting is reset.

### 6. Suspension and closure
- **Suspended:** `ALTER ROLE <user> NOLOGIN`, then its sessions ended: a session running ended, measured, and a new login is refused. **Reactivated:** `LOGIN` again, the data as it was.
- **Closed,** at the data deletion date the retention already sets: `SET ROLE <user>; DROP DATABASE <db> WITH (FORCE); RESET ROLE; DROP ROLE <user>`, measured; the user logs in no more. Never earlier for non-payment.

### 7. Sampling every database, every hour
One query by the backend's role, every database's `pg_database_size` and `pg_stat_database.numbackends`: **250 ms for a thousand databases** (7.4 GB of empty ones), three runs alike. The hourly sample costs nothing to speak of at the beta's scale, nor long after.

### 8. Backups: WAL-G, as FF's own server
- **WAL-G 3.0.9 works with PostgreSQL 18,** measured: `backup-push`, `wal-push` from `archive_command`, `backup-fetch`, `wal-fetch` as `restore_command`, encrypted with libsodium, compressed with zstd, to an S3 bucket. The customers' server gets the setup FF's has (`deploy/backup`): a base backup each night, every WAL segment shipped within 5 minutes, to the second site, 7 days by default as RDS keeps.
- **One customer's database from a point in time:** the whole server restored elsewhere to that time, then that one database copied into a new one of the account's, with `pg_dump` and `pg_restore` as the new database's own user. Measured on a small server: open after 10 s, the copy done at 10.4 s, the rows before the time there and none after, its extensions with it. The restored server needs the settings the server had, `max_connections` at least: with fewer, PostgreSQL aborts the recovery ("max_connections = 100 is a lower setting than on the primary server"), which the runbook says.

### 9. The connection string, and certificates
- **FF gives** `postgresql://<user>:<password>@<host>:5432/<db>?sslmode=require`, its host the server's name (`FF_DATA_DB_HOST`).
- **As drivers read `require`,** measured: libpq's (psql, `pg_dump`, psycopg and most others) encrypts and doesn't check the certificate; node-postgres 8.23.1 checks it as `verify-full`, against Node.js's own CAs, and says so in a warning of its own. So:
  - **in production,** the server's certificate is for its name from a public CA (Let's Encrypt): every driver connects, and node-postgres checks it with nothing to set;
  - **with a CA of the operator's,** as RDS has its own, and in development, the CA's certificate is given to functions: FF mounts it in their pods and names it in `NODE_EXTRA_CA_CERTS`, unless the function names its own, as AWS Lambda's Node.js runtime keeps RDS's CAs at a path for that variable. Measured: node-postgres refuses the development certificate with `sslmode=require` alone, and accepts it with the CA in `NODE_EXTRA_CA_CERTS`. libpq's own `verify-full` takes the CA in `sslrootcert`, which the guide shows for a laptop.
  - not `sslmode=no-verify`: node-postgres's own word, which libpq refuses ("invalid sslmode value").

## Consequences

- **V-02** adds the server to `docker-compose.yml` (PostgreSQL 18.6, TLS from a development CA, this `pg_hba.conf`, the backend's role, on a Docker network of its own that the cluster's node joins at the lowest gateway priority), the settings `FF_DATA_DB_*` checked at start, and `deploy/data-db/README.md` for production.
- **V-03** makes databases with the statements above, the verifier computed by the backend, and tests them against a real server (L2); the tenants' policy gains its rule; the CA reaches functions' pods when the setting names one.
- **V-04**'s hourly sample is the query above; the signal and its end, as above.
- **V-05**'s runbook restores one database as above, and the monthly drill does it.
- **Opaque names everywhere:** in the server's log, its backups and its metrics, nothing names a customer; FF's own table maps them.

## Alternatives considered

- **A StatefulSet in the cluster,** run by an operator such as CloudNativePG. The backend's role in the cluster can't make one (its admission policy keeps it to tenants' namespaces), customers' disks would sit beside FF's control plane, and FF's own database is outside the cluster already (D13).
- **A server per account.** Isolation by the machine, at a server's cost per customer: for the bigger plans later, the `server` column keeping room for it.
- **A schema per customer in one database.** Cheaper, but no `CONNECT` wall, extensions shared, and neither RDS's shape nor `pg_dump` of a database.
- **A hard wall on size:** a tablespace per database on a disk with quotas, which needs a superuser and the operator's tooling. The plan kept the signal, which the spike shows working.
- **Functions only, no internet:** safer, but no `psql`, migration tool or `pg_dump` from a developer's machine; the plan kept the server reachable, with TLS and SCRAM (D14).

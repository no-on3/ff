# Data services spike

The measurements behind [ADR 0008](../../../docs/adr/0008-customer-databases.md) (customers' databases) and [ADR 0009](../../../docs/adr/0009-buckets.md) (buckets behind FF's S3 front door): the [step-2 plan](../../../docs/step-2-plan.md)'s V-01. Two halves, run one at a time:

```bash
hack/spikes/data-services/databases.sh                # about 30 minutes, most of it making and dropping 1,000 databases
DATABASES=100 hack/spikes/data-services/databases.sh  # about 8 minutes
hack/spikes/data-services/buckets.sh                  # about 5 minutes; npm and pip fetch the SDKs the first time
```

Both need FF's development stack (`docker compose up`: its SeaweedFS on 127.0.0.1:9003) and Node.js 22 or later; the databases half also the development cluster (`hack/k8s/cluster-up.sh`), `psql` 16 or later here, and about 8 GB free on Docker's disk for its thousand databases; the buckets half Python 3 and the AWS CLI v2. Each writes its results to `hack/.data-services-spike/` (`databases.md`, `buckets.md`) and removes what it made on exit (`KEEP=1` leaves the databases half running). FF's own containers, namespaces and buckets are never touched.

## The databases half (`databases.sh`)

- **A server of its own,** `postgres:18.6-bookworm` with WAL-G 3.0.9 (FF's version, its checksum checked), on a Docker network of its own (10.199.0.0/24, private, as production's would be), TLS with a certificate from a CA made for the run, SCRAM only, and a `pg_hba.conf` that lets the backend's role into the maintenance database only, each customer's user into its namesake database only, the superuser over the socket only, and nothing without TLS.
- **The backend's role,** `ff_admin`: `CREATEDB CREATEROLE`, no superuser, with `pg_read_all_stats` and `pg_signal_backend`. It makes each customer's user and database as the backend will (`ff_` and 24 random characters for both; the password a SCRAM verifier made by `scram-verifier.mjs`, so that only the verifier reaches the server and its log).
- **What a customer's user can do:** its own tables, schemas and PostgreSQL's trusted extensions; not dblink, postgres_fdw, a program or a file of the server, another database or role; not the other customer's database, nor the maintenance database, nor without TLS; and not an eleventh connection past its limit of 10.
- **From a tenant pod** in a namespace of its own, with the tenants' default-deny NetworkPolicy, no internet, and one rule more, egress to the server's address on 5432: the server answers; a decoy PostgreSQL that trusts everyone, next to it on the same network, doesn't; nor the internet, nor another port of the server; and with the rule taken away, nor the server.
- **Past the plan's storage:** the read-only signal as an app meets it (SQLSTATE 25006), turned off by the session itself, taken away by the customer's user, and its sessions under way ended so that each starts again read-only.
- **Suspension and deletion:** `NOLOGIN` and the sessions ended, then `LOGIN` again; a database dropped by the backend's role through `SET ROLE` to its owner.
- **Sampling:** `DATABASES` (1,000) empty databases made, every one's size and connections read three times as the hourly sample will, then dropped.
- **A point in time:** a base backup with WAL-G to a bucket of the development store, rows before and after a target time, the server restored elsewhere to it, and that one database copied into a new one of the account's with `pg_dump` and `pg_restore`.

## The buckets half (`buckets.sh`)

- **`front-door.mjs`,** a minimal S3 front door, Node.js's standard library only: AWS Signature Version 4 in a header or a presigned URL, with keys of its own; aws-chunked uploads, signed chunk by chunk or not, with a trailing checksum or not, each chunk's signature and the checksum checked before the upload completes; a key reaching its own buckets only, `CopyObject`'s source included; each customer bucket mapped to the store's, in requests and in the XML answers; streaming both ways; one JSON line a request in its log, and counts per bucket, minute and AWS's request class.
- **The clients,** each with its defaults and only an endpoint, the region and a key: AWS's SDK for JavaScript v3 (`sdk-check.mjs`: strings, buffers and streams, odd keys, ranges, listings with pages and delimiters, copies, multipart with `lib-storage` and by hand, presigned GET and PUT, expired and tampered URLs, a wrong secret, another account's bucket, an unsupported operation; virtual-hosted, path-style, and an IP address for the endpoint); boto3 (`boto3_check.py`); and the AWS CLI v2 (`cp`, multipart, `ls`, `sync` both ways, `presign`, `rm`).
- **Throughput:** 200 MB up and down with the AWS CLI, straight to the store and through the front door, and one 200 MB `PutObject` with the SDK; the front door's peak memory.
- **A bucket's size:** `OBJECTS` (10,000) objects, then the bucket's listing walked through the front door, against SeaweedFS's own count.

# Your FF database, to AWS RDS

FF's databases are PostgreSQL 18, as RDS for PostgreSQL runs it, and never a newer version than RDS offers: a database moves to RDS with PostgreSQL's own tools, `pg_dump` and `pg_restore`, nothing of FF's in between.

## What you need

- **The database's connection string,** with its password: `ff db password <name>` makes a new one, shown once, if you no longer have it. Your functions' secret `DATABASE_URL` holds it too, but FF never shows a secret back.
- **`pg_dump` and `pg_restore` 18,** the major version of the server, from PostgreSQL's packages or its Docker image (`docker run --rm -it postgres:18 bash`).
- **An RDS for PostgreSQL 18 instance,** with a database and a user for your app, which `pg_restore` can reach: from where you run it, or through a machine in its VPC. Its storage at least your database's size (`ff db get <name>`), with room to grow.

## Moving it

1. **Stop the writes:** scale your functions down, or put your app in maintenance, so that nothing changes during the copy. A database of a few GB copies in minutes.
2. **Dump it from FF,** in PostgreSQL's custom format, without owners or rights: FF's user owns your tables, and RDS's will be another.

   ```bash
   pg_dump --format=custom --no-owner --no-acl --dbname "$FF_DATABASE_URL" --file app.dump
   ```

3. **Restore it into RDS,** as RDS's user, checking RDS's certificate with its CA bundle ([AWS's `global-bundle.pem`](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)):

   ```bash
   pg_restore --no-owner --no-acl --exit-on-error \
     --dbname "postgresql://app:<password>@<instance>.<region>.rds.amazonaws.com:5432/app?sslmode=verify-full&sslrootcert=global-bundle.pem" \
     app.dump
   ```

   The extensions FF lets you create (`pgcrypto`, `citext`, `hstore`, `pg_trgm`, `uuid-ossp` and PostgreSQL's other trusted ones) are RDS's too.

4. **Check it:** count a few tables' rows on both sides, and run your app's own checks against RDS.
5. **Point your app at RDS:** on AWS Lambda, its `DATABASE_URL` from Secrets Manager or the function's environment; while it still runs on FF, `ff secrets set <function> DATABASE_URL`. Node.js on Lambda finds RDS's CAs at the path AWS documents for `NODE_EXTRA_CA_CERTS`.
6. **Then delete the database on FF** (`ff db delete <name>`), once you no longer need it: until then, its storage is billed.

## Without stopping the writes

PostgreSQL's logical replication copies a database while it is written to, then keeps the copy current until you switch. On FF it needs two things its server doesn't give customers today: a user with the `REPLICATION` attribute, and the server's `wal_level` at `logical`. Ask FF's operator if your database is too large to stop for the copy.

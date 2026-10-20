# A reference PostgreSQL for FF's database and Keycloak's, when FF runs its own server: PostgreSQL 15.19 with
# WAL-G 3.0.9, which ships each WAL segment and a nightly base backup, encrypted, to a second site's S3. A managed
# PostgreSQL has its provider's point-in-time recovery instead (deploy/backup/README.md).
#   docker build -t ff-postgres-walg deploy/backup/postgres-walg
FROM postgres:15.19-bookworm
ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256=965a7147852435bc4b54f272799b63df826b54ef65cf7c4fc688c82b96c0c4eb
ADD --checksum=sha256:${WALG_SHA256} https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-20.04-amd64 /usr/local/bin/wal-g
RUN chmod 0755 /usr/local/bin/wal-g && wal-g --version
# WAL archiving (postgresql.backup.conf), which the server's own configuration includes from its first start;
# a base backup carries that configuration, so a restored server archives too. WAL-G's settings come from the
# environment (walg.env.example).
COPY postgresql.backup.conf /etc/postgresql/postgresql.backup.conf
COPY include-backup.sh /docker-entrypoint-initdb.d/00-include-backup.sh
# The server starts as postgres, never as root, so the entrypoint needs no gosu to drop to it: gosu goes, with the
# advisories of the Go it was built with (the image scan, hack/ci.sh). Numeric, for Kubernetes' runAsNonRoot.
RUN rm /usr/local/bin/gosu
USER 999:999

# The server of customers' databases (ADR 0008): PostgreSQL 18.6, apart from FF's own, TLS and SCRAM only, with who
# may log in where in pg_hba.conf; and WAL-G 3.0.9, which ships each WAL segment and a nightly base backup, encrypted,
# to a second site, as FF's own server does (deploy/backup). Development runs it from docker-compose.yml's data-db
# (its profile "data"); production runs it on a server of its own (README.md).
#   docker build -t ff-data-db deploy/data-db
FROM postgres:18.6-bookworm
ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256=965a7147852435bc4b54f272799b63df826b54ef65cf7c4fc688c82b96c0c4eb
ADD --checksum=sha256:${WALG_SHA256} https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-20.04-amd64 /usr/local/bin/wal-g
RUN chmod 0755 /usr/local/bin/wal-g && wal-g --version
# The server's settings and its pg_hba.conf, which its own configuration includes from its first start (initdb/).
COPY postgresql.data.conf postgresql.archive.conf pg_hba.conf /etc/postgresql/
COPY initdb/ /docker-entrypoint-initdb.d/
# The server starts as postgres, never as root, so the entrypoint needs no gosu to drop to it: gosu goes, with the
# advisories of the Go it was built with (the image scan, hack/ci.sh). Numeric, for Kubernetes' runAsNonRoot.
RUN rm /usr/local/bin/gosu
USER 999:999

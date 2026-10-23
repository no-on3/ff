#!/usr/bin/env bash
# Run once, when the server is first made: its certificate. In production the operator puts it, and its key (owned
# by 999, mode 0600), in /var/lib/postgresql/tls/ (README.md). In development, with FF_DATA_DB_TLS_NAMES set (the
# names and addresses it answers at, such as DNS:localhost,IP:10.199.0.10), a CA of its own and a certificate from it
# are made here: hack/k8s/data-db-up.sh copies the CA out, for the backend and for functions' pods.
set -euo pipefail
tls=/var/lib/postgresql/tls
if [ -f "$tls/server.crt" ] && [ -f "$tls/server.key" ]; then
  exit 0
fi
if [ -z "${FF_DATA_DB_TLS_NAMES:-}" ]; then
  echo "no certificate in $tls, and no FF_DATA_DB_TLS_NAMES to make one: the server takes TLS connections only" >&2
  exit 1
fi
mkdir -p "$tls"
chmod 0700 "$tls"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=FF data-db development CA" \
  -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=ff-data-db" -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$FF_DATA_DB_TLS_NAMES" >"$tls/server.ext"
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 825 \
  -extfile "$tls/server.ext" -out "$tls/server.crt" 2>/dev/null
rm "$tls/server.csr" "$tls/server.ext"
chmod 0600 "$tls/server.key" "$tls/ca.key"
echo "made a development CA and a certificate for $FF_DATA_DB_TLS_NAMES"

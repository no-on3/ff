#!/bin/sh
# The server of customers' caches as it starts: its certificate, then FF's agent, which starts each cache's process.
# In production the operator puts the certificate and its key in $FF_CACHE_DIR/tls/ (README.md), and the SHA-256 of the
# backend's token in FF_CACHE_AGENT_TOKEN_SHA256. In development, with FF_CACHE_TLS_NAMES set (the names and addresses
# it answers at, such as DNS:localhost,IP:10.199.0.11), a CA of its own and a certificate from it are made at the first
# start (hack/k8s/cache-up.sh copies the CA out, for the backend and for functions' pods), and FF_CACHE_AGENT_TOKEN, the
# token itself, is taken: production refuses it in the backend.
set -eu
tls="$FF_CACHE_DIR/tls"
if [ ! -f "$tls/server.crt" ] || [ ! -f "$tls/server.key" ]; then
  if [ -z "${FF_CACHE_TLS_NAMES:-}" ]; then
    echo "no certificate in $tls, and no FF_CACHE_TLS_NAMES to make one: the caches take TLS connections only" >&2
    exit 1
  fi
  mkdir -p "$tls"
  chmod 0750 "$tls"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=FF caches development CA" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=ff-cache" -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$FF_CACHE_TLS_NAMES" >"$tls/server.ext"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 825 \
    -extfile "$tls/server.ext" -out "$tls/server.crt" 2>/dev/null
  rm "$tls/server.csr" "$tls/server.ext"
  chmod 0600 "$tls/ca.key"
  echo "made a development CA and a certificate for $FF_CACHE_TLS_NAMES"
fi
if [ -z "${FF_CACHE_AGENT_TOKEN_SHA256:-}" ] && [ -n "${FF_CACHE_AGENT_TOKEN:-}" ]; then
  FF_CACHE_AGENT_TOKEN_SHA256="$(printf '%s' "$FF_CACHE_AGENT_TOKEN" | sha256sum | cut -d' ' -f1)"
  export FF_CACHE_AGENT_TOKEN_SHA256
fi
unset FF_CACHE_AGENT_TOKEN
exec node /opt/ff-cache/agent.mjs

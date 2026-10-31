#!/bin/sh
# The server of customers' mail as it starts: its certificate, Postfix's settings, then FF's agent, which starts
# Postfix. In production the operator puts the certificate and its key in $FF_MAIL_DIR/tls/ (README.md), and the SHA-256
# of the backend's token in FF_MAIL_AGENT_TOKEN_SHA256. In development, with FF_MAIL_TLS_NAMES set (the names and
# addresses it answers at, such as DNS:localhost,IP:10.199.0.12), a CA of its own and a certificate from it are made at
# the first start (hack/k8s/mail-up.sh copies the CA out, for the backend), and FF_MAIL_AGENT_TOKEN, the token itself,
# is taken: production refuses it in the backend.
#   FF_MAIL_HOSTNAME    its name, which customers' return-path domains' MX records and their SPF records name
#   FF_MAIL_RELAY_FROM  the addresses that may hand it mail to send, the backend's: CIDRs, a space between each
#   FF_MAIL_RELAYHOST   host:port that takes every message instead of its recipients' servers: development and tests
set -eu
: "${FF_MAIL_HOSTNAME:?FF_MAIL_HOSTNAME is the server's name, which customers' return-path domains' MX records name}"
: "${FF_MAIL_RELAY_FROM:?FF_MAIL_RELAY_FROM names the addresses that may hand it mail to send: the backend's}"
tls="$FF_MAIL_DIR/tls"
if [ ! -f "$tls/server.crt" ] || [ ! -f "$tls/server.key" ]; then
  if [ -z "${FF_MAIL_TLS_NAMES:-}" ]; then
    echo "no certificate in $tls, and no FF_MAIL_TLS_NAMES to make one: the backend hands mail over TLS only" >&2
    exit 1
  fi
  mkdir -p "$tls"
  chmod 0750 "$tls"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=FF mail development CA" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=ff-mail" -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$FF_MAIL_TLS_NAMES" >"$tls/server.ext"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 825 \
    -extfile "$tls/server.ext" -out "$tls/server.crt" 2>/dev/null
  rm "$tls/server.csr" "$tls/server.ext"
  chmod 0600 "$tls/ca.key"
  echo "made a development CA and a certificate for $FF_MAIL_TLS_NAMES"
fi

# What comes back for every return-path domain, bounces.mail.<domain> and FF's own, goes to one Maildir, whatever its
# address: a message's own, b-<message>@, names it.
mkdir -p "$FF_MAIL_DIR/bounces/new" "$FF_MAIL_DIR/bounces/cur" "$FF_MAIL_DIR/bounces/tmp"
chown -R ff-bounces:ff-bounces "$FF_MAIL_DIR/bounces"
chmod 0700 "$FF_MAIL_DIR/bounces"
printf '/^bounces\\.mail\\./ OK\n' >/etc/postfix/ff-bounce-domains
printf '/@bounces\\.mail\\./ bounces/\n' >/etc/postfix/ff-bounce-mailbox
uid="$(id -u ff-bounces)"
postconf -e \
  "myhostname = $FF_MAIL_HOSTNAME" \
  "myorigin = \$myhostname" \
  "smtpd_banner = \$myhostname ESMTP" \
  "inet_interfaces = all" \
  "inet_protocols = ipv4" \
  "mydestination =" \
  "local_recipient_maps =" \
  "alias_maps =" \
  "alias_database =" \
  "mynetworks = 127.0.0.0/8 $FF_MAIL_RELAY_FROM" \
  "smtpd_relay_restrictions = permit_mynetworks, reject_unauth_destination" \
  "smtpd_recipient_restrictions = permit_mynetworks, reject_unauth_destination" \
  "disable_vrfy_command = yes" \
  "virtual_mailbox_domains = regexp:/etc/postfix/ff-bounce-domains" \
  "virtual_mailbox_maps = regexp:/etc/postfix/ff-bounce-mailbox" \
  "virtual_mailbox_base = $FF_MAIL_DIR" \
  "virtual_uid_maps = static:$uid" \
  "virtual_gid_maps = static:$uid" \
  "smtpd_tls_cert_file = $tls/server.crt" \
  "smtpd_tls_key_file = $tls/server.key" \
  "smtpd_tls_security_level = may" \
  "smtp_tls_security_level = may" \
  "smtp_tls_loglevel = 1" \
  "message_size_limit = 20971520" \
  "maximal_queue_lifetime = 1d" \
  "bounce_queue_lifetime = 1d" \
  "maillog_file = /dev/stdout" \
  "compatibility_level = 3.11"
if [ -n "${FF_MAIL_RELAYHOST:-}" ]; then
  postconf -e "relayhost = [${FF_MAIL_RELAYHOST%:*}]:${FF_MAIL_RELAYHOST##*:}" "smtp_tls_security_level = none"
  echo "every message to $FF_MAIL_RELAYHOST, not its recipients' servers: development and tests only"
fi

if [ -z "${FF_MAIL_AGENT_TOKEN_SHA256:-}" ] && [ -n "${FF_MAIL_AGENT_TOKEN:-}" ]; then
  FF_MAIL_AGENT_TOKEN_SHA256="$(printf '%s' "$FF_MAIL_AGENT_TOKEN" | sha256sum | cut -d' ' -f1)"
  export FF_MAIL_AGENT_TOKEN_SHA256
fi
unset FF_MAIL_AGENT_TOKEN
exec node /opt/ff-mail/agent.mjs

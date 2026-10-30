#!/usr/bin/env bash
# The server of customers' mail, for development (ADR 0012): docker-compose.yml's mail, built and started on the data
# network beside the database and cache servers, handing every message to Mailpit (http://localhost:58025) instead of
# its recipients' servers; the CA of its certificate copied to hack/.mail-server/ca.crt, for the backend; and the
# backend's settings printed, for BE/.env. Functions never reach it: their mail goes through the SES endpoint.
#   hack/k8s/mail-up.sh          # prints the FF_EMAIL_* lines
#   hack/k8s/mail-up.sh down     # stops it; what bounced and wasn't read stays (… down --volumes: it goes)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

address="${FF_MAIL_ADDRESS:-10.199.0.12}"
compose=(docker compose --project-directory "$FF_REPO_ROOT" -f "$FF_REPO_ROOT/docker-compose.yml" --profile mail --profile auth)
out="$FF_REPO_ROOT/hack/.mail-server"

container() { "${compose[@]}" ps -q mail 2>/dev/null; }

case "${1:-up}" in
  up)
    "$FF_REPO_ROOT/hack/check-resources.sh"
    "${compose[@]}" up -d --wait mailpit mail
    mkdir -p "$out"
    docker cp -q "$(container):/var/lib/ff-mail/tls/ca.crt" "$out/ca.crt"
    cat <<EOT
# Customers' mail (hack/k8s/mail-up.sh): add to BE/.env. Every message lands in Mailpit, http://localhost:58025.
FF_EMAIL_SMTP_HOST=$address
FF_EMAIL_AGENT_URL=https://$address:6391
FF_EMAIL_AGENT_TOKEN=ff-mail-dev
FF_EMAIL_CA_FILE=$out/ca.crt
EOT
    ;;
  down)
    shift
    "${compose[@]}" rm -s -f mail >/dev/null
    if [ "${1:-}" = --volumes ]; then docker volume rm "$(basename "$FF_REPO_ROOT")_mail" >/dev/null; fi
    ;;
  *)
    echo "usage: $0 [up|down [--volumes]]" >&2
    exit 2
    ;;
esac

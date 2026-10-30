#!/usr/bin/env bash
# The DKIM half of step 4's mail spike (the step-4 plan's W-01): a message signed by nodemailer, as the backend would
# sign a customer's with the customer's own key, handed to a Postfix of its own with a return path naming it; Postfix
# relays it to a receiving server of the spike's, which keeps what it takes and refuses one address, as a mailbox that
# doesn't exist; at the other end, the signature checked against the public key FF would have the customer publish;
# and the bounce, which Postfix sends back to the return path, read. The containers and their network go on exit.
#   hack/spikes/mail/dkim.sh          # about a minute; builds the Postfix image and fetches mailauth the first time
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$FF_REPO_ROOT/hack/.spike-mail/dkim"
"$FF_REPO_ROOT/hack/check-resources.sh"
rm -rf "$work/received" && mkdir -p "$work/received" && chmod 777 "$work/received"

# The domain's key, as FF makes one for a customer's domain: RSA, 2,048 bits.
openssl genrsa -out "$work/dkim.pem" 2048 2>/dev/null
public_key="$(openssl rsa -in "$work/dkim.pem" -pubout -outform DER 2>/dev/null | base64 -w0)"

network="ff-spike-mail-$$" receiver="ff-spike-receiver-$$" postfix="ff-spike-postfix-$$"
cleanup() { docker rm -f -v "$receiver" "$postfix" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$network" >/dev/null
docker run -d --name "$receiver" --network "$network" --network-alias receiver -e PORT=2525 -e OUT=/out \
  -v "$here/receiver.mjs:/receiver.mjs:ro" -v "$work/received:/out" node:24-alpine node /receiver.mjs >/dev/null
docker build -q -t ff-spike-postfix "$here/postfix" >/dev/null
docker run -d --name "$postfix" --network "$network" -p 127.0.0.1::25 -e RELAY=receiver:2525 -e BOUNCES=bounces.spike.test ff-spike-postfix >/dev/null
smtp_port="$(docker port "$postfix" 25/tcp | head -1 | sed 's/.*://')"
# Docker's proxy takes a connection before Postfix listens: ready once Postfix itself says 220.
for _ in $(seq 60); do
  [ "$( (exec 3<>"/dev/tcp/127.0.0.1/$smtp_port" && timeout 2 head -c 3 <&3) 2>/dev/null || true)" = 220 ] && break
  sleep 0.5
done
echo "{\"postfix\": \"$(docker exec "$postfix" postconf -h mail_version)\"}"

MODULES="$FF_REPO_ROOT/BE/node_modules" SMTP_PORT="$smtp_port" KEY_FILE="$work/dkim.pem" node "$here/send.mjs"
started=$SECONDS
for _ in $(seq 60); do
  [ -f "$work/received/received-1.eml" ] && docker exec "$postfix" grep -q 'report-type=delivery-status' /var/mail/bounces 2>/dev/null && break
  sleep 0.5
done
echo "{\"the message delivered and the bounce back within, s\": $((SECONDS - started))}"
docker exec "$postfix" cat /var/mail/bounces >"$work/bounces.mbox" 2>/dev/null || : >"$work/bounces.mbox"
docker logs "$postfix" >"$work/postfix.log" 2>&1

# mailauth, at a release at least two weeks old (7.3.0, 2026-10-10), to verify the signature as a mailbox provider would.
[ -d "$work/js/node_modules/mailauth" ] || npm install --prefix "$work/js" --no-audit --no-fund --silent mailauth@7.3.0 >/dev/null
MODULES="$work/js" RECEIVED="$work/received" PUBLIC_KEY="$public_key" BOUNCES="$work/bounces.mbox" node "$here/verify.mjs" | tee "$work/results.jsonl"
jq -rs '"checks: \(map(select(.want == .got)) | length) of \(length) as wanted\(map(select(.want != .got) | "\n  not as wanted: \(.check) (want \(.want), got \(.got))") | join(""))"' "$work/results.jsonl"

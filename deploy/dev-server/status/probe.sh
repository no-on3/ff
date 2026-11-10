#!/usr/bin/env bash
# The status page's probe (../README.md): every minute, as the user ff-status, each piece of FF as a customer meets
# it, through the server's own proxy as the internet reaches FF: the API's /healthz, the console, Keycloak's login
# page, the Lambda endpoint invoking the canary, S3 reading the probe's page, SQS sending to the probe's queue and
# receiving the message, the SES endpoint refusing a request that isn't signed, the canary at its URL, and the
# probe's site. Its key reaches the probe's bucket, queue and function alone. The checks run at once, each within
# 10 s; each minute is one line of /data/ff/status/minutes.log, in JSON: the minute, and each check's answer (whether
# it was the one expected, its status, its time in milliseconds, and the days its certificate has left). Once a day,
# the day 91 days old is removed. What it reads, setup.sh writes: probe.env, the probe's names and addresses;
# probe-key.curl, its key as curl's settings, so that it is never on a command line; roots.pem, the CAs it trusts,
# the proxy's own among them.
#   /usr/local/lib/ff-status/probe.sh       (as ff-status: ff-status-probe.service runs setup.sh's copy, every minute)
# Its tests (hack/test-status.sh) give FF_STATUS_HOME and FF_STATUS_PORT, a stand-in's, in place of the server's, and
# FF_STATUS_TIMEOUT, a check's time in seconds, shorter.
set -euo pipefail
dir="${FF_STATUS_HOME:-/data/ff/status}"
port="${FF_STATUS_PORT:-443}" # the proxy's, on this server: every name is reached there
timeout="${FF_STATUS_TIMEOUT:-10}"
keep_days=90
setting() { sed -n "s/^$1=//p" "$dir/probe.env" | tail -n 1; }
domain="$(setting domain)" region="$(setting region)" function="$(setting function)" bucket="$(setting bucket)"
queue_url="$(setting queue_url)" canary_url="$(setting canary_url)" site_url="$(setting site_url)"
[ -n "$domain" ] && [ -n "$site_url" ] || { echo "probe.sh: $dir/probe.env lacks the probe's names: setup.sh writes them" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
minute="$(date -u +%Y-%m-%dT%H:%M:00Z)"

# <name> [curl options…] <URL>: one request, through the proxy; its body in <name>.body, its headers in
# <name>.headers; prints its status, its time in seconds, and its certificate's expiry, one to a line.
call() {
  local name=$1
  shift
  curl -sS --max-time "$timeout" --cacert "$dir/roots.pem" --connect-to "::127.0.0.1:$port" -D "$work/$name.headers" \
    -o "$work/$name.body" -w '%{http_code}\n%{time_total}\n%{certs}' "$@" 2>"$work/$name.error" |
    sed -n '1p; 2p; s/^Expire date: *//p' | head -n 3
}
key=(-K "$dir/probe-key.curl") # with --aws-sigv4 aws:amz:<region>:<service>, a request signed with the probe's key
# <name> <status expected> <text expected> <status> <seconds> <expiry>: the check's line in <name>.json, ok when the
# status is the one expected and its body or headers hold the text.
judged() {
  local name=$1 expected=$2 text=$3 code=${4:-000} seconds=${5:-0} expiry=${6:-} ok=false days=null
  if [ "$code" = "$expected" ] && cat "$work/$name.body" "$work/$name.headers" 2>/dev/null | grep -F -- "$text" >/dev/null; then ok=true; fi
  if [ -n "$expiry" ]; then days=$((($(date -d "$expiry" +%s) - $(date +%s)) / 86400)); fi
  jq -cn --arg name "$name" --argjson ok "$ok" --argjson code "$((10#$code))" --arg seconds "$seconds" --argjson days "$days" \
    --arg error "$(head -c 300 "$work/$name.error" 2>/dev/null)" \
    '{($name): ({ok: $ok, code: $code, ms: ($seconds | tonumber * 1000 | round), days: $days} + if $error == "" then {} else {error: $error} end)}' \
    >"$work/$name.json"
}
# <name> <status expected> <text expected> [curl options…] <URL>
check() {
  local name=$1 expected=$2 text=$3 answer
  shift 3
  mapfile -t answer < <(call "$name" "$@")
  judged "$name" "$expected" "$text" "${answer[@]}"
}
# SQS's round trip: a message sent to the probe's queue, then received and deleted with any an earlier minute left.
sqs() { # <operation> <JSON>: SQS's answer, signed, its body in sqs-<operation>.body
  local -a answer
  mapfile -t answer < <(call "sqs-$1" --aws-sigv4 "aws:amz:$region:sqs" "${key[@]}" -H 'content-type: application/x-amz-json-1.0' \
    -H "x-amz-target: AmazonSQS.$1" --data-binary "$2" "https://sqs.$domain/")
  printf '%s\n' "${answer[@]}"
}
sqs_round_trip() {
  local body="probe $minute" sent received handle total expiry
  mapfile -t sent < <(sqs SendMessage "$(jq -cn --arg q "$queue_url" --arg b "$body" '{QueueUrl: $q, MessageBody: $b}')")
  mapfile -t received < <(sqs ReceiveMessage "$(jq -cn --arg q "$queue_url" '{QueueUrl: $q, MaxNumberOfMessages: 10, WaitTimeSeconds: 1}')")
  total="$(awk -v sent="${sent[1]:-0}" -v received="${received[1]:-0}" 'BEGIN { print sent + received }')"
  expiry="${received[2]:-}"
  for handle in $(jq -r '.Messages[]?.ReceiptHandle' "$work/sqs-ReceiveMessage.body" 2>/dev/null); do
    sqs DeleteMessage "$(jq -cn --arg q "$queue_url" --arg h "$handle" '{QueueUrl: $q, ReceiptHandle: $h}')" >/dev/null
  done
  # Judged on the receive: 200, and the message just sent among those received, after a send that was 200.
  if jq -e --arg body "$body" 'any(.Messages[]?; .Body == $body)' "$work/sqs-ReceiveMessage.body" >/dev/null 2>&1; then
    echo "the message sent, received" >"$work/sqs.body"
  else
    cp "$work/sqs-ReceiveMessage.body" "$work/sqs.body" 2>/dev/null || : >"$work/sqs.body"
  fi
  cat "$work/sqs-SendMessage.error" "$work/sqs-ReceiveMessage.error" >"$work/sqs.error" 2>/dev/null || true
  : >"$work/sqs.headers"
  local code="${received[0]:-000}"
  [ "${sent[0]:-000}" = 200 ] || code="${sent[0]:-000}"
  judged sqs 200 "the message sent, received" "$code" "$total" "$expiry"
}

{
  check api 200 '"status":"ok"' "https://api.$domain/healthz" &
  check console 200 'id="root"' "https://console.$domain/" &
  check login 200 'name="username"' -G "https://login.$domain/realms/ff/protocol/openid-connect/auth" -d client_id=ff-console \
    --data-urlencode "redirect_uri=https://console.$domain/" -d response_type=code -d scope=openid &
  check lambda 200 canary --aws-sigv4 "aws:amz:$region:lambda" "${key[@]}" --data-binary '{}' "https://lambda.$domain/2015-03-31/functions/$function/invocations" &
  check s3 200 "FF's status probe" --aws-sigv4 "aws:amz:$region:s3" "${key[@]}" "https://s3.$domain/$bucket/index.html" &
  sqs_round_trip &
  check ses 403 MissingAuthenticationTokenException "https://email.$domain/v2/email/account" &
  check canary 200 canary "$canary_url" &
  check site 200 "FF's status probe" "$site_url" &
  wait
}
jq -cn --arg at "$minute" '{at: $at, checks: (reduce inputs as $check ({}; . + $check))}' \
  "$work"/{api,console,login,lambda,s3,sqs,ses,canary,site}.json >>"$dir/minutes.log"

# The minutes kept 90 days, by whole days: the file rewritten once a day, without the day 91 days old, rather than
# each minute, without the minute.
cutoff="$(date -u -d "$keep_days days ago" +%Y-%m-%d)"
if [[ "$(head -n 1 "$dir/minutes.log" | jq -r .at)" < "$cutoff" ]]; then
  jq -c --arg cutoff "$cutoff" 'select(.at >= $cutoff)' "$dir/minutes.log" >"$dir/minutes.log.new" && mv "$dir/minutes.log.new" "$dir/minutes.log"
fi

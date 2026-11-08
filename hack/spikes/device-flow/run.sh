#!/usr/bin/env bash
# The developer tools' spike of `ff login`'s device flow (RFC 8628): a Rust prototype (src/lib.rs, with ureq as `ff`
# has it) against the development realm's ff-cli client, in a Keycloak of its own (compose project
# ff-device-flow-spike, port 28180, removed on exit; the developer's own is never touched). The user's part is done as a
# browser does it (browser.py). Each answer the flow can meet: pending, slow down, denied, approved, expired; the
# tokens' lifetimes, with and without offline access; a refresh, a refresh token used twice, a refresh after the
# session's end, an offline token revoked. What it found lands in hack/.spike-device-flow/results.md.
#   hack/spikes/device-flow/run.sh      # about 3 minutes, Keycloak's start among them
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$repo/hack/.spike-device-flow"
source "$repo/hack/lib/checks.sh"
port="${FF_DEVICE_FLOW_PORT:-28180}"
issuer="http://localhost:$port/realms/ff"
client=ff-cli
user=device-spike@ff.test
password=device-spike-1
mkdir -p "$work"
rm -f "$work"/*.json
results="$work/results.md"
export CARGO_TARGET_DIR="$work/target" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"
compose=(docker compose -p ff-device-flow-spike -f "$repo/docker-compose.yml" --profile auth)

section "the prototype: its tests, against a stand-in issuer"
"$repo/hack/check-resources.sh"
tests="$( (cd "$here" && cargo test --locked --quiet --lib 2>&1) | sed -n 's/^test result: \(ok\. [0-9]* passed\).*/\1/p')"
check "the tests pass" true "$([[ "$tests" == "ok. "* ]] && echo true || echo "$tests")"
(cd "$here" && cargo build --locked --quiet --release)
spike() { "$work/target/release/device-flow-spike" "$1" "$issuer" "$client" "${@:2}"; }
field() { jq -r "$1" <<<"$2"; } # <jq filter> <json>
browser() { python3 -I "$here/browser.py" "$(jq -r '.verification_uri_complete // .verification_uri' "$1")" "$(jq -r .user_code "$1")" "$user" "$password" "$2"; }

section "a Keycloak of its own, the development realm imported"
"$repo/hack/check-resources.sh"
on_exit '"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true'
FF_KEYCLOAK_PORT="$port" "${compose[@]}" up -d keycloak >/dev/null 2>&1
started="$(date +%s)"
until curl -fsS "$issuer/.well-known/openid-configuration" >/dev/null 2>&1; do
  [ $(($(date +%s) - started)) -lt 180 ] || fail "Keycloak answered nothing in 180 s"
  sleep 2
done
keycloak_s=$(($(date +%s) - started))
admin_token() {
  curl -fsS "http://localhost:$port/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | jq -r .access_token
}
admin() { # <method> <path under /admin/realms/ff> [<json>]
  curl -fsS -X "$1" "http://localhost:$port/admin/realms/ff$2" -H "Authorization: Bearer $(admin_token)" \
    -H 'Content-Type: application/json' ${3:+--data "$3"}
}
# A customer as the console's sign-up makes one: an e-mail, verified, and a password, with nothing more to do.
admin POST /users "$(jq -nc --arg u "$user" --arg p "$password" \
  '{username: $u, email: $u, emailVerified: true, enabled: true, firstName: "Device", lastName: "Spike",
    credentials: [{type: "password", value: $p, temporary: false}]}')" >/dev/null
user_id="$(admin GET "/users?username=$user&exact=true" | jq -r '.[0].id')"
check "the customer made" true "$([ -n "$user_id" ] && [ "$user_id" != null ] && echo true || echo false)"
realm="$(admin GET '')"
client_json="$(admin GET "/clients?clientId=$client" | jq '.[0]')"

section "a device code, and the polls before the user's answer"
started="$(spike start openid "$work/pending.json")"
check "the device code given" true "$(field '.user_code != null and .expires_in > 0' "$started")"
pending="$(spike poll "$work/pending.json" || true)"
check "polled at once: pending" pending "$(field .poll "$pending")"
again="$(spike poll "$work/pending.json" || true)"
check "polled again at once: slow down" slow_down "$(field '.poll // .refused.error' "$again")"

section "the user denies"
spike start openid "$work/denied.json" >/dev/null
denied_pages="$(browser "$work/denied.json" deny 2>&1 || true)"
denied="$(spike poll "$work/denied.json" || true)"
check "the poll after: denied" denied "$(field '.poll // .refused.error' "$denied")"

section "the user approves, the command waiting at the interval"
approved_start="$(spike start openid "$work/approved.json")"
spike wait "$work/approved.json" "$work/tokens.json" >"$work/wait.out" &
waiting=$!
sleep 7 # a poll or two pending first, as when the user takes a moment
approved_pages="$(browser "$work/approved.json" approve 2>&1 || true)"
wait "$waiting" || true
waited="$(cat "$work/wait.out")"
check "the wait ends approved" true "$(field .approved "$waited")"
check "the access token is for the API" true "$(field '.tokens.access.aud | if type == "array" then index("ff-api") != null else . == "ff-api" end' "$waited")"

section "refreshes, then the session ended"
refreshed="$(spike refresh "$work/tokens.json" || true)"
check "a refresh gives new tokens" true "$(field .refreshed "$refreshed")"
cp "$work/tokens.json" "$work/tokens-before.json"
spike refresh "$work/tokens.json" >/dev/null || true
reused="$(spike refresh "$work/tokens-before.json" || true)"
admin POST "/users/$user_id/logout" >/dev/null
after_logout="$(spike refresh "$work/tokens.json" || true)"
check "a refresh after the session's end is refused" invalid_grant "$(field .refused.error "$after_logout")"

section "offline access: a token that outlives the session"
offline_start="$(spike start 'openid offline_access' "$work/offline.json" || true)"
offline_pages=""
offline=""
if [ "$(field .user_code "$offline_start")" != null ]; then
  offline_pages="$(browser "$work/offline.json" approve 2>&1 || true)"
  offline="$(spike poll "$work/offline.json" "$work/offline-tokens.json" || true)"
fi
offline_tokens='{}'
offline_after_logout='{}'
offline_revoked='{}'
if [ -n "$offline" ] && [ "$(field .poll "$offline")" = approved ]; then
  offline_tokens="$(spike refresh "$work/offline-tokens.json" || true)"
  admin POST "/users/$user_id/logout" >/dev/null
  offline_after_logout="$(spike refresh "$work/offline-tokens.json" || true)"
  spike revoke "$work/offline-tokens.json" >/dev/null
  offline_revoked="$(spike refresh "$work/offline-tokens.json" || true)"
fi
check "an offline token outlives the session's end" true "$(field '.refreshed == true and .tokens.refresh.typ == "Offline"' "$offline_after_logout")"
check "an offline token, revoked, is refused" invalid_grant "$(field '.refused.error' "$offline_revoked")"

section "a device code that expires"
admin PUT '' '{"oauth2DeviceCodeLifespan": 5}' >/dev/null
spike start openid "$work/expired.json" >/dev/null
sleep 7
expired="$(spike poll "$work/expired.json" || true)"
check "the poll after its end: expired" expired "$(field '.poll // .refused.error' "$expired")"

{ echo "# ff login's device flow against Keycloak ($(date -u +%F))"; echo
  echo "Keycloak $(docker inspect --format '{{.Config.Image}}' "$("${compose[@]}" ps -q keycloak)" | sed 's/.*://'), the development realm, client \`$client\`; up in $keycloak_s s."
  echo; echo "## The realm, as imported"; echo
  echo "| Setting | Value |"; echo "|---|---|"
  for key in accessTokenLifespan ssoSessionIdleTimeout ssoSessionMaxLifespan offlineSessionIdleTimeout offlineSessionMaxLifespanEnabled oauth2DeviceCodeLifespan oauth2DevicePollingInterval revokeRefreshToken; do
    echo "| $key | $(field ".$key" "$realm") |"
  done
  echo "| ff-cli's default scopes | $(field '(.defaultClientScopes // []) | join(", ")' "$client_json") |"
  echo "| ff-cli's optional scopes | $(field '(.optionalClientScopes // []) | join(", ")' "$client_json") |"
  echo "| ff-cli's consent required | $(field .consentRequired "$client_json") |"
  echo; echo "## What each step answered"; echo
  echo "| Step | Answer |"; echo "|---|---|"
  echo "| A device code | \`$started\` |"
  echo "| Polled at once | \`$pending\` |"
  echo "| Polled again at once | \`$again\` |"
  echo "| The pages, denying | $(tr '\n' ';' <<<"$denied_pages" | sed 's/;$//; s/;/; /g') |"
  echo "| Polled after the denial | \`$denied\` |"
  echo "| The pages, approving | $(tr '\n' ';' <<<"$approved_pages" | sed 's/;$//; s/;/; /g') |"
  echo "| The wait | \`$(jq -c '{approved, polls}' <<<"$waited")\` |"
  echo "| The tokens | \`$(jq -c .tokens <<<"$waited")\` |"
  echo "| A refresh | \`$(jq -c . <<<"$refreshed")\` |"
  echo "| A refresh token used again after a refresh | \`$(jq -c '{refreshed, refused}' <<<"$reused")\` |"
  echo "| A refresh after the session's end | \`$after_logout\` |"
  echo "| A device code with offline_access | \`$offline_start\` |"
  echo "| The pages, offline | $(tr '\n' ';' <<<"$offline_pages" | sed 's/;$//; s/;/; /g') |"
  echo "| Its poll | \`${offline:-not polled}\` |"
  echo "| Its refresh | \`$(jq -c . <<<"$offline_tokens")\` |"
  echo "| Its refresh after the session's end | \`$(jq -c . <<<"$offline_after_logout")\` |"
  echo "| Its refresh after its revocation | \`$(jq -c . <<<"$offline_revoked")\` |"
  echo "| A device code past its end (lifespan 5 s) | \`$expired\` |"
} >"$results"
cat "$results"
checks_done spike-device-flow

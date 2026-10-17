#!/usr/bin/env bash
# L5 cross-account suite (client-readiness plan, P-10 to P-12): every route of
# the OpenAPI document, called as another account, anonymously, and as real
# users with real accounts.
#   - Development mode: account A creates a function and invokes it. Account B
#     (X-FF-Dev-Account) calls every route on it. Each answers 404, exactly as for
#     a function that doesn't exist, and A's function, history and limits don't
#     change. B's list doesn't show A's function, and the function B creates is
#     B's alone. The account routes need a user: development mode has none.
#   - Through the guard, on a second backend in OIDC mode with the local Keycloak:
#     nobody authenticated gets 401 on every route but the public ones.
#   - Sign-up (L4 of P-12): a user registers through Keycloak's own form and
#     verifies the address through Mailpit; a second one is made through the
#     admin API. Each creates an account, which waits for approval (you get an
#     e-mail in Mailpit) and can't deploy. Approved by SQL, as P-71's routes will,
#     account 1 deploys a function. Account 2 then calls every route on account 1's
#     function and account: 404 each time, and nothing changes. A tampered token,
#     and one meant for another API, get 401.
#   - API keys (P-13): account 1's key reads and invokes (L4), within its scopes,
#     and stops when revoked; account 2's key gets 404 on account 1's function.
#   - Members (P-16): user 2 is invited into account 1 and joins on the next call
#     (L4), reads as a viewer, writes as a developer, then is removed; the last
#     owner can't leave. Member routes never reach another account's members.
# A route without a rule here fails the suite, so a new route can't skip it.
# Same stack as hack/e2e.sh (hack/lib/e2e-stack.sh), plus Keycloak and Mailpit, in
# compose project "ff-e2e-tenancy" (ports 55433 / 59004 / 58180 / 51026 / 58026);
# removed on exit with the namespaces.
#   hack/e2e-tenancy.sh [--teardown]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-e2e-tenancy
E2E_NAME=e2e-tenancy
export FF_PG_PORT="${FF_E2E_TENANCY_PG_PORT:-55433}"
export FF_S3_PORT="${FF_E2E_TENANCY_S3_PORT:-59004}"
export FF_KEYCLOAK_PORT="${FF_E2E_TENANCY_KEYCLOAK_PORT:-58180}"
export FF_MAIL_SMTP_PORT="${FF_E2E_TENANCY_MAIL_SMTP_PORT:-51026}"
export FF_MAIL_UI_PORT="${FF_E2E_TENANCY_MAIL_UI_PORT:-58026}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
[ "${1:-}" = "--teardown" ] && e2e_teardown=true

account_a="$(random_account)"
account_b="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account_a")" "$(tenant_namespace "$account_b")")
api="http://127.0.0.1:$(free_port)"
api_oidc="http://127.0.0.1:$(free_port)"
operator=operator@ff.test

as_a() { http_at "$api" "$@"; }
as_b() { http_at "$api" "$1" "$2" "${3:-}" -H "X-FF-Dev-Account: $account_b"; }
# The development header, which OIDC mode must ignore.
anonymous() { http_at "$api_oidc" "$1" "$2" "${3:-}" -H "X-FF-Dev-Account: $account_a"; }
# with_token <token> <method> <path> [body] [curl option...]: through the guard.
with_token() {
  local token=$1 method=$2 path=$3 body=${4:-}
  shift $(($# < 4 ? $# : 4))
  http_at "$api_oidc" "$method" "$path" "$body" -H "Authorization: Bearer $token" "$@"
}
message() { jq -r .message "$work/body"; }
# Routes anyone may call (@Public()).
public_routes=("GET /healthz")
is_public() { local route; for route in "${public_routes[@]}"; do [ "$route" = "$1" ] && return 0; done; return 1; }

# The local Keycloak (realm "ff", deploy/keycloak/ff-realm.json).
keycloak="http://localhost:$FF_KEYCLOAK_PORT"
mailpit="http://localhost:$FF_MAIL_UI_PORT"
keycloak_admin() {
  curl -sS -X POST "$keycloak/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | jq -r .access_token
}
# keycloak_user <e-mail>: a user with a verified address and the password "l5-password-1", through the admin API.
keycloak_user() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$keycloak/admin/realms/ff/users" \
    -H "authorization: Bearer $(keycloak_admin)" -H 'content-type: application/json' \
    -d "$(jq -cn --arg email "$1" '{username: $email, email: $email, emailVerified: true, enabled: true,
      firstName: "L5", lastName: "Test", credentials: [{type: "password", value: "l5-password-1", temporary: false}]}')"
}
# form_action <html file>: the action URL of the page's form.
form_action() { grep -o '<form[^>]*action="[^"]*"' "$1" | head -1 | sed 's/.*action="//; s/"$//; s/&amp;/\&/g'; }
# keycloak_register <e-mail>: Keycloak's own sign-up, as a person does it: the
# registration form; the verification e-mail, read through Mailpit; its link; then
# the password "l5-password-1". Prints the last redirect: the console's URL with a code.
keycloak_register() {
  local email=$1 jar="$work/register.jar" next link
  rm -f "$jar"
  curl -sS -c "$jar" -b "$jar" -o "$work/register.html" \
    "$keycloak/realms/ff/protocol/openid-connect/registrations?client_id=ff-console&response_type=code&scope=openid&redirect_uri=http%3A%2F%2Flocalhost%3A5199%2F&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
  next="$(curl -sS -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' -X POST "$(form_action "$work/register.html")" \
    --data-urlencode "email=$email" --data-urlencode firstName=L5 --data-urlencode lastName=Signup)"
  [[ $next == *VERIFY_EMAIL* ]] || fail "the registration form did not lead to e-mail verification (got: $next)"
  curl -sS -c "$jar" -b "$jar" -o /dev/null "$next" # sends the e-mail
  for _ in $(seq 1 20); do
    link="$(mail_to "$email" | grep -o "$keycloak/realms/ff/login-actions/action-token?[^ ]*" | head -1 || true)"
    [ -n "$link" ] && break
    sleep 1
  done
  [ -n "$link" ] || fail "no verification e-mail reached $email in Mailpit"
  next="$(curl -sS -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' "$link")"
  [[ $next == *UPDATE_PASSWORD* ]] || fail "the verification link did not lead to setting a password (got: $next)"
  curl -sS -c "$jar" -b "$jar" -o "$work/password.html" "$next"
  curl -sS -c "$jar" -b "$jar" -o /dev/null -w '%{redirect_url}' -X POST "$(form_action "$work/password.html")" \
    --data-urlencode password-new=l5-password-1 --data-urlencode password-confirm=l5-password-1
}
# keycloak_token <client> <e-mail>: an access token, through the password grant.
keycloak_token() {
  curl -sS -X POST "$keycloak/realms/ff/protocol/openid-connect/token" \
    -d grant_type=password -d "client_id=$1" -d "username=$2" -d password=l5-password-1 -d scope=openid | jq -r .access_token
}
# mail_to <address>: the text of the newest e-mail to that address in Mailpit (lines end without \r).
mail_to() {
  local id
  id="$(curl -sS "$mailpit/api/v1/search?query=to:$1" | jq -r '.messages[0].ID // empty')"
  [ -z "$id" ] || curl -sS "$mailpit/api/v1/message/$id" | jq -r '.Subject + "\n" + .Text' | tr -d '\r'
}
# approve <account...>: as P-71's admin route will, until it exists.
approve() {
  local ids
  ids="$(printf "'%s'," "$@")"
  "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc \
    "UPDATE accounts SET status = 'active' WHERE id IN (${ids%,})" >/dev/null
}

e2e_dependencies keycloak mailpit
e2e_cluster

echo "== backends"
e2e_build
e2e_migrate "${e2e_base_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${e2e_base_env[@]}" PORT="${api##*:}" \
  FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a"
e2e_start_backend "$work/backend-oidc.log" "$api_oidc" "${e2e_base_env[@]}" PORT="${api_oidc##*:}" \
  FF_AUTH_MODE=oidc FF_DEV_ACCOUNT_ID= FF_OIDC_ISSUER="$keycloak/realms/ff" FF_OIDC_AUDIENCE=ff-api \
  FF_SMTP_URL="smtp://localhost:$FF_MAIL_SMTP_PORT" FF_OPERATOR_EMAIL="$operator" FF_ADMIN_URL=http://localhost:5174
echo "  accounts A $account_a and B $account_b on $api; OIDC mode on $api_oidc"

echo "== account A's function"
code='export async function handler(event: { body: { name?: string } }) {
  return { message: `Hello ${event.body.name ?? "world"}` };
}'
function_body() { jq -cn --arg code "$code" --arg name "$1" '{name: $name, runtime: "nodejs", code: $code, memory: 128, timeout: 5}'; }
created="$(as_a POST /functions "$(function_body l5-a)")"
check "A creates a function" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
as_a POST "/functions/$id/invoke" '{"input":{"name":"A"}}' >/dev/null
check "A invokes it" 201 "$(status)"
# snapshot <caller> <function ID>: what another account's calls must not change.
snapshot() {
  local caller=$1 fn=$2
  jq -cn --argjson fn "$("$caller" GET "/functions/$fn")" --argjson history "$("$caller" GET "/functions/$fn/invocations")" \
    '{name: $fn.name, code: $fn.code, status: $fn.status, memory: $fn.memory, timeout: $fn.timeout,
      minInstances: $fn.minInstances, maxInstances: $fn.maxInstances, invocations: $history.total}'
}
before="$(snapshot as_a "$id")"
missing="$(node -e "console.log(require('crypto').randomUUID())")"
as_a GET "/functions/$missing" >/dev/null
check "a function that doesn't exist answers 404" "404 Function with ID $missing not found" "$(status) $(message)"
as_a GET /functions '' -H 'X-FF-Dev-Account: 12345' >/dev/null
check "a malformed X-FF-Dev-Account is refused" 400 "$(status)"

# Every route of the OpenAPI document, as "METHOD /path/{param}".
document="$(curl -sS "$api/api-json")"
mapfile -t routes < <(jq -r '.paths | to_entries[] | .key as $path | .value | to_entries[]
  | select(.key | IN("get", "put", "post", "delete", "patch")) | "\(.key | ascii_upcase) \($path)"' <<<"$document")
[ "${#routes[@]}" -gt 0 ] || fail "the OpenAPI document lists no routes"

# path_for <template> <method> <function ID> <account ID> [key ID]: the path, with its required query parameters filled in.
path_for() {
  local template=$1 method=$2 path name params=()
  case $template in
    /accounts/*) path="${template//\{id\}/$4}" ;;
    /api-keys/*) path="${template//\{id\}/${5:-0123456789ab}}" ;;
    *) path="${template//\{id\}/$3}" ;;
  esac
  path="${path//\{functionId\}/$3}"
  path="${path//\{userId\}/$missing}"
  [[ $path != *'{'* ]] || fail "$method $template: no value for its path parameter"
  while read -r name; do
    case $name in
      start) params+=("start=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)") ;;
      end) params+=("end=$(date -u +%Y-%m-%dT%H:%M:%SZ)") ;;
      *) fail "$method $template: no value for its required query parameter $name" ;;
    esac
  done < <(jq -r --arg path "$template" --arg method "${method,,}" \
    '.paths[$path][$method].parameters // [] | .[] | select(.in == "query" and .required) | .name' <<<"$document")
  local IFS='&'
  printf '%s%s' "$path" "${params:+?${params[*]}}"
}
# body_for <method> <template>: a valid body, so that only the account check can refuse the call.
body_for() {
  case "$1 $2" in
    "POST /functions") function_body l5-other ;;
    "PUT /functions/{id}") echo '{"name": "l5-taken-over"}' ;;
    "POST /functions/{id}/invoke") echo '{"input": {"name": "B"}}' ;;
    "PUT /functions/{id}/scaling-config") echo '{"maxInstances": 1}' ;;
    "POST /accounts") echo '{"name": "L5 second account", "useCase": "isolation tests"}' ;;
    "PATCH /accounts/{id}") echo '{"name": "taken over"}' ;;
    "POST /api-keys") echo '{"name": "l5", "scopes": ["functions:read"]}' ;;
    "POST /members") echo '{"email": "l5-invitee@ff.test", "role": "viewer"}' ;;
    "PATCH /members/{userId}") echo '{"role": "viewer"}' ;;
    POST* | PUT* | PATCH*) echo '{}' ;;
  esac
}
needs_user="400 Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage accounts"
needs_user_for_keys="400 Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage API keys"
needs_user_for_members="400 Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage members"

echo "== development mode, account B, on every route (${#routes[@]})"
own=""
for route in "${routes[@]}" "DELETE /functions/{id} (last)"; do
  method="${route%% *}"
  template="${route#* }"
  case "$route" in
    "DELETE /functions/{id}") continue ;; # last, once everything else is checked
    "DELETE /functions/{id} (last)") template="/functions/{id}" ;;
  esac
  if is_public "$method $template"; then
    as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" >/dev/null
    check "$route: public" 200 "$(status)"
    continue
  fi
  case "$method $template" in
    "GET /functions")
      listed="$(as_b GET /functions | jq --arg id "$id" 'map(select(.id == $id)) | length')"
      check "$route: B's list doesn't show A's function" "200 0" "$(status) $listed"
      ;;
    "POST /functions")
      own="$(as_b POST /functions "$(body_for POST /functions)" | jq -r .id)"
      check "$route: B creates its own function" 201 "$(status)"
      as_a GET "/functions/$own" >/dev/null
      check "  ... which A doesn't see" "404 Function with ID $own not found" "$(status) $(message)"
      ;;
    "GET /me")
      check "$route: B sees its own account only" "[\"$account_b\"]" "$(as_b GET /me | jq -c '[.accounts[].id]')"
      ;;
    "POST /accounts" | "GET /accounts/{id}" | "PATCH /accounts/{id}")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: needs a logged-in user" "$needs_user" "$(status) $(message)"
      ;;
    "GET /api-keys" | "POST /api-keys" | "DELETE /api-keys/{id}")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: needs a logged-in user" "$needs_user_for_keys" "$(status) $(message)"
      ;;
    *" /members"*)
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: needs a logged-in user" "$needs_user_for_members" "$(status) $(message)"
      ;;
    *'{'*)
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$method $template: B gets 404, as for a missing function" "404 Function with ID $id not found" "$(status) $(message)"
      ;;
    *) fail "$route: the L5 suite has no rule for this route" ;;
  esac
done
check "A's function, history and limits are unchanged" "$before" "$(snapshot as_a "$id")"
as_b DELETE "/functions/$own" >/dev/null
check "B deletes its own function" 200 "$(status)"

echo "== nobody authenticated, through the guard, on every route (${#routes[@]})"
for route in "${routes[@]}"; do
  method="${route%% *}"
  template="${route#* }"
  anonymous "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
  if is_public "$route"; then
    check "$route: public, 200" 200 "$(status)"
  else
    check "$route: 401" 401 "$(status)"
  fi
done

echo "== sign-up: Keycloak's form, e-mail verification through Mailpit, a pending account"
user_1="l5-$account_a@ff.test"
user_2="l5-$account_b@ff.test"
check "user 1 registers, verifies the address and sets a password, back to the console with a code" true \
  "$([[ "$(keycloak_register "$user_1")" == http://localhost:5199/?*code=* ]] && echo true || echo false)"
check "user 2 is made through the admin API" 201 "$(keycloak_user "$user_2")"
token_1="$(keycloak_token ff-e2e "$user_1")"
token_2="$(keycloak_token ff-e2e "$user_2")"
[ -n "$token_1" ] && [ "$token_1" != null ] && [ -n "$token_2" ] && [ "$token_2" != null ] ||
  fail "the users could not log in through ff-e2e"
as_user_1() { with_token "$token_1" "$@"; }
as_user_2() { with_token "$token_2" "$1" "$2" "${3:-}" -H "X-FF-Account: ${account_2:-}"; }

me_1="$(as_user_1 GET /me)"
check "the backend creates user 1 on the first call, with no account" "200 $user_1 []" \
  "$(status) $(jq -r '"\(.user.email) \(.accounts)"' <<<"$me_1")"
as_user_1 GET /functions >/dev/null
check "without an account, account routes say how to make one" \
  "403 This user has no account yet: create one with POST /accounts" "$(status) $(message)"
account_1="$(as_user_1 POST /accounts '{"name": "L5 one", "useCase": "isolation tests"}' | jq -r .id)"
check "user 1 creates an account: pending, and its owner" "201 pending owner" \
  "$(status) $(as_user_1 GET "/accounts/$account_1" | jq -r '"\(.status) \(.role)"')"
check "you get an e-mail to approve it" true \
  "$(mail_to "$operator" | grep -q "($account_1)" && mail_to "$operator" | grep -q 'http://localhost:5174/accounts?status=pending' && echo true || echo false)"
as_user_1 POST /accounts '{"name": "L5 again"}' >/dev/null
check "one account at a time waits for approval" "400 You already have an account waiting for approval" "$(status) $(message)"
as_user_1 POST /functions "$(function_body l5-one)" >/dev/null
check "a pending account can't deploy" \
  "403 Your account is waiting for approval: you can deploy and invoke functions once it is approved" "$(status) $(message)"
account_2="$(with_token "$token_2" POST /accounts '{"name": "L5 two"}' | jq -r .id)"
check "user 2 creates an account" 201 "$(status)"
e2e_namespaces+=("$(tenant_namespace "$account_1")" "$(tenant_namespace "$account_2")")
approve "$account_1" "$account_2"

created="$(as_user_1 POST /functions "$(function_body l5-one)")"
check "approved, account 1 deploys a function" "201 ACTIVE $account_1" \
  "$(status) $(jq -r '"\(.status) \(.accountId)"' <<<"$created")"
fn_1="$(jq -r .id <<<"$created")"
as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"name":"one"}}' >/dev/null
check "and invokes it" 201 "$(status)"
key_1="$(as_user_1 POST /api-keys '{"name": "l5 reader", "scopes": ["functions:read", "functions:invoke"]}' | jq -r .key)"
check "account 1's owner creates an API key, shown once" "201 true" "$(status) $([[ $key_1 =~ ^ffk_[0-9a-f]{12}_ ]] && echo true || echo false)"
key_1_id="$(cut -d_ -f2 <<<"$key_1")"
invitation_1="$(as_user_1 POST /members '{"email": "l5-someone@ff.test", "role": "viewer"}' | jq -r .id)"
check "account 1's owner invites someone" 201 "$(status)"
user_1_id="$(jq -r .user.id <<<"$me_1")"
before_1="$(snapshot as_user_1 "$fn_1")"
name_1="$(as_user_1 GET "/accounts/$account_1" | jq -r .name)"
members_1="$(as_user_1 GET /members | jq -c '{members: [.members[].email], invitations: [.invitations[].email]}')"

echo "== account 2, on account 1's function and account, on every route (${#routes[@]})"
for route in "${routes[@]}" "DELETE /functions/{id} (last)"; do
  method="${route%% *}"
  template="${route#* }"
  case "$route" in
    "DELETE /functions/{id}") continue ;;
    "DELETE /functions/{id} (last)") template="/functions/{id}" ;;
  esac
  is_public "$method $template" && continue
  case "$method $template" in
    "GET /functions")
      listed="$(as_user_2 GET /functions | jq --arg id "$fn_1" 'map(select(.id == $id)) | length')"
      check "$route: account 2's list doesn't show account 1's function" "200 0" "$(status) $listed"
      ;;
    "POST /functions")
      own="$(as_user_2 POST /functions "$(body_for POST /functions)" | jq -r .id)"
      check "$route: account 2 deploys its own function" 201 "$(status)"
      as_user_1 GET "/functions/$own" >/dev/null
      check "  ... which account 1 doesn't see" "404 Function with ID $own not found" "$(status) $(message)"
      ;;
    "GET /me")
      check "$route: user 2 sees their own account only" "[\"$account_2\"]" "$(as_user_2 GET /me | jq -c '[.accounts[].id]')"
      ;;
    "POST /accounts")
      second="$(as_user_2 POST /accounts "$(body_for POST /accounts)" | jq -r .id)"
      check "$route: user 2 creates a second account" 201 "$(status)"
      as_user_1 GET "/accounts/$second" >/dev/null
      check "  ... which user 1 doesn't see" "404 Account $second not found" "$(status) $(message)"
      ;;
    "GET /accounts/{id}" | "PATCH /accounts/{id}")
      as_user_2 "$method" "$(path_for "$template" "$method" "$fn_1" "$account_1")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: account 1 is not found for user 2" "404 Account $account_1 not found" "$(status) $(message)"
      ;;
    "GET /api-keys")
      check "$route: account 2 doesn't see account 1's key" 0 \
        "$(as_user_2 GET /api-keys | jq --arg id "$key_1_id" 'map(select(.id == $id)) | length')"
      ;;
    "POST /api-keys")
      key_2="$(as_user_2 POST /api-keys '{"name": "l5 two", "scopes": ["functions:read", "functions:write", "functions:invoke", "metrics:read"]}' | jq -r .key)"
      check "$route: account 2 makes its own key" 201 "$(status)"
      ;;
    "DELETE /api-keys/{id}")
      as_user_2 DELETE "/api-keys/$key_1_id" >/dev/null
      check "$route: account 2 can't revoke account 1's key" "404 API key $key_1_id not found" "$(status) $(message)"
      ;;
    "GET /members")
      people="$(as_user_2 GET /members)"
      check "$route: user 2 sees account 2's members, none of account 1's people" "200 true 0" \
        "$(status) $(jq -r --arg me "$user_2" --arg u1 "$user_1" \
          '"\([.members[].email] | index($me) != null) \([.members[].email, .invitations[].email] | map(select(. == $u1 or . == "l5-someone@ff.test")) | length)"' <<<"$people")"
      ;;
    "POST /members")
      as_user_2 POST /members '{"email": "l5-second-invitee@ff.test", "role": "viewer"}' >/dev/null
      check "$route: user 2 invites into account 2 only" 201 "$(status)"
      ;;
    "PATCH /members/{userId}" | "DELETE /members/{userId}")
      as_user_2 "$method" "/members/$user_1_id" "$(body_for "$method" "$template")" >/dev/null
      check "$route: user 1 is not a member of account 2" "404 Member $user_1_id not found" "$(status) $(message)"
      ;;
    "DELETE /members/invitations/{id}")
      as_user_2 DELETE "/members/invitations/$invitation_1" >/dev/null
      check "$route: account 2 can't cancel account 1's invitation" "404 Invitation $invitation_1 not found" "$(status) $(message)"
      ;;
    *'{'*)
      as_user_2 "$method" "$(path_for "$template" "$method" "$fn_1" "$account_1")" "$(body_for "$method" "$template")" >/dev/null
      check "$method $template: 404, as for a missing function" "404 Function with ID $fn_1 not found" "$(status) $(message)"
      ;;
    *) fail "$route: the L5 suite has no rule for this route" ;;
  esac
done
check "account 1's function, history and limits are unchanged" "$before_1" "$(snapshot as_user_1 "$fn_1")"
check "and so is its name" "$name_1" "$(as_user_1 GET "/accounts/$account_1" | jq -r .name)"
check "and so are its members and invitations" "$members_1" \
  "$(as_user_1 GET /members | jq -c '{members: [.members[].email], invitations: [.invitations[].email]}')"
with_token "$token_2" GET /functions '' -H "X-FF-Account: $account_1" >/dev/null
check "naming account 1 in X-FF-Account: 404" "404 Account $account_1 not found" "$(status) $(message)"
with_token "$token_2" GET /functions >/dev/null
check "user 2, now in two accounts, must name one" \
  "400 This user belongs to several accounts: name one in the X-FF-Account header" "$(status) $(message)"
echo "== API keys"
listed="$(with_token "$key_1" GET /functions | jq --arg id "$fn_1" 'map(select(.id == $id)) | length')"
check "account 1's key lists its account's functions" "200 1" "$(status) $listed"
with_token "$key_1" POST "/functions/$fn_1/invoke" '{"input":{"name":"key"}}' >/dev/null
check "and invokes them" 201 "$(status)"
with_token "$key_1" PUT "/functions/$fn_1" '{"name": "renamed"}' >/dev/null
check "but can't change one without functions:write" "403 This API key lacks the scope functions:write" "$(status) $(message)"
for path in /me /api-keys /members; do
  with_token "$key_1" GET "$path" >/dev/null
  check "a key can't call GET $path, which takes a user's token" \
    "403 API keys can't call this route: it takes a user's token" "$(status) $(message)"
done
for route in "${routes[@]}"; do
  method="${route%% *}"
  template="${route#* }"
  case $template in /functions/* | /metrics/*) ;; *) continue ;; esac
  with_token "$key_2" "$method" "$(path_for "$template" "$method" "$fn_1" "$account_1")" "$(body_for "$method" "$template")" >/dev/null
  check "account 2's key on $route: 404" "404 Function with ID $fn_1 not found" "$(status) $(message)"
done
as_user_1 DELETE "/api-keys/$key_1_id" >/dev/null
check "account 1 revokes its key" 200 "$(status)"
with_token "$key_1" GET /functions >/dev/null
check "which stops working at once" "401 The API key was revoked" "$(status) $(message)"
check "account 1's function was invoked once more, by its key, and is otherwise unchanged" \
  "$(jq -c '.invocations += 1' <<<"$before_1")" "$(snapshot as_user_1 "$fn_1")"

echo "== members (P-16): user 2 is invited into account 1"
as_user_1 POST /members "$(jq -cn --arg email "$user_2" '{email: $email, role: "viewer"}')" >/dev/null
check "account 1's owner invites user 2's address as a viewer" 201 "$(status)"
check "user 2 gets an e-mail with the console's address" true \
  "$(mail_to "$user_2" | grep -q 'http://localhost:5199' && echo true || echo false)"
check "user 2 joins on the next call: account 1 is in GET /me, as a viewer" "viewer" \
  "$(with_token "$token_2" GET /me | jq -r --arg id "$account_1" '.accounts[] | select(.id == $id) | .role')"
as_member() { with_token "$token_2" "$1" "$2" "${3:-}" -H "X-FF-Account: $account_1"; }
listed="$(as_member GET /functions | jq --arg id "$fn_1" 'map(select(.id == $id)) | length')"
check "as a viewer, user 2 reads account 1's functions" "200 1" "$(status) $listed"
as_member POST "/functions/$fn_1/invoke" '{"input":{}}' >/dev/null
check "but can't invoke them" "403 The viewer role can't do this" "$(status) $(message)"
user_2_id="$(with_token "$token_2" GET /me | jq -r .user.id)"
as_user_1 PATCH "/members/$user_2_id" '{"role": "developer"}' >/dev/null
check "the owner makes user 2 a developer" 200 "$(status)"
as_member POST "/functions/$fn_1/invoke" '{"input":{}}' >/dev/null
check "who now invokes" 201 "$(status)"
as_member GET /members >/dev/null
check "but doesn't manage members" "403 The developer role can't do this" "$(status) $(message)"
as_user_1 DELETE "/members/$user_1_id" >/dev/null
check "the last owner can't leave" "400 An account needs an owner: make another member owner first" "$(status) $(message)"
as_user_1 DELETE "/members/$user_2_id" >/dev/null
check "the owner removes user 2" 200 "$(status)"
as_member GET /functions >/dev/null
check "who can't reach account 1 any more" "404 Account $account_1 not found" "$(status) $(message)"

with_token "${token_1%?????}AAAAA" GET /functions >/dev/null
check "a tampered token: 401" "401 The token is invalid" "$(status) $(message)"
with_token "$(keycloak_token admin-cli "$user_1")" GET /functions >/dev/null
check "a token meant for another API (Keycloak's admin-cli client): 401" \
  "401 The token is not meant for this API" "$(status) $(message)"
check "A's function, history and limits are still unchanged" "$before" "$(snapshot as_a "$id")"

echo "$E2E_NAME: $passed checks passed"

#!/usr/bin/env bash
# L5 cross-account suite (client-readiness plan, P-10 and P-11): every route of
# the OpenAPI document, called as another account, anonymously, and with tokens.
#   - Account A (the development account) creates a function and invokes it.
#   - Account B (X-FF-Dev-Account) calls every route on A's function. Each answers
#     404, exactly as for a function that doesn't exist, and A's function, history
#     and limits don't change. B's list doesn't show A's function, and the
#     function B creates is B's alone.
#   - Through the guard, on a second backend in OIDC mode with the local Keycloak:
#     nobody authenticated gets 401 on every route but the public ones; two users
#     logged in through the ff-e2e client get 403 "no account yet" until P-12;
#     a tampered token, and one meant for another API, get 401.
# A route without a rule here fails the suite, so a new route can't skip it.
# Same stack as hack/e2e.sh (hack/lib/e2e-stack.sh), plus Keycloak, in compose
# project "ff-e2e-tenancy" on ports 55433 / 59004 / 58180; removed on exit with
# the namespaces.
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

as_a() { http_at "$api" "$@"; }
as_b() { http_at "$api" "$1" "$2" "${3:-}" -H "X-FF-Dev-Account: $account_b"; }
# The development header, which OIDC mode must ignore.
anonymous() { http_at "$api_oidc" "$1" "$2" "${3:-}" -H "X-FF-Dev-Account: $account_a"; }
# with_token <token> <method> <path> [body]: through the guard.
with_token() { http_at "$api_oidc" "$2" "$3" "${4:-}" -H "Authorization: Bearer $1"; }
# Routes anyone may call (@Public()).
public_routes=("GET /health")
is_public() { local route; for route in "${public_routes[@]}"; do [ "$route" = "$1" ] && return 0; done; return 1; }

# The local Keycloak (realm "ff", deploy/keycloak/ff-realm.json), through its admin API.
keycloak="http://localhost:$FF_KEYCLOAK_PORT"
keycloak_admin() {
  curl -sS -X POST "$keycloak/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin | jq -r .access_token
}
# keycloak_user <e-mail>: a user with a verified address and the password "l5-password-1".
keycloak_user() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$keycloak/admin/realms/ff/users" \
    -H "authorization: Bearer $(keycloak_admin)" -H 'content-type: application/json' \
    -d "$(jq -cn --arg email "$1" '{username: $email, email: $email, emailVerified: true, enabled: true,
      firstName: "L5", lastName: "Test", credentials: [{type: "password", value: "l5-password-1", temporary: false}]}')"
}
# keycloak_token <client> <e-mail>: an access token, through the password grant.
keycloak_token() {
  curl -sS -X POST "$keycloak/realms/ff/protocol/openid-connect/token" \
    -d grant_type=password -d "client_id=$1" -d "username=$2" -d password=l5-password-1 -d scope=openid | jq -r .access_token
}

e2e_dependencies keycloak mailpit
e2e_cluster

echo "== backends"
e2e_build
e2e_migrate "${e2e_base_env[@]}"
e2e_start_backend "$work/backend.log" "$api" "${e2e_base_env[@]}" PORT="${api##*:}" \
  FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a"
e2e_start_backend "$work/backend-oidc.log" "$api_oidc" "${e2e_base_env[@]}" PORT="${api_oidc##*:}" \
  FF_AUTH_MODE=oidc FF_DEV_ACCOUNT_ID= FF_OIDC_ISSUER="$keycloak/realms/ff" FF_OIDC_AUDIENCE=ff-api
echo "  accounts A $account_a and B $account_b on $api; OIDC mode on $api_oidc"

echo "== account A's function"
code='export async function handler(event: { body: { name?: string } }) {
  return { message: `Hello ${event.body.name ?? "world"}` };
}'
created="$(as_a POST /functions "$(jq -n --arg code "$code" '{name: "l5-a", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')")"
check "A creates a function" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
as_a POST "/functions/$id/invoke" '{"input":{"name":"A"}}' >/dev/null
check "A invokes it" 201 "$(status)"
# What B's calls must not change: as A sees it.
snapshot() {
  jq -cn --argjson fn "$(as_a GET "/functions/$id")" --argjson history "$(as_a GET "/functions/$id/invocations")" \
    '{name: $fn.name, code: $fn.code, status: $fn.status, memory: $fn.memory, timeout: $fn.timeout,
      minInstances: $fn.minInstances, maxInstances: $fn.maxInstances, invocations: $history.total}'
}
before="$(snapshot)"
missing="$(node -e "console.log(require('crypto').randomUUID())")"
as_a GET "/functions/$missing" >/dev/null
check "a function that doesn't exist answers 404" "404 Function with ID $missing not found" "$(status) $(jq -r .message "$work/body")"
as_a GET /functions '' -H 'X-FF-Dev-Account: 12345' >/dev/null
check "a malformed X-FF-Dev-Account is refused" 400 "$(status)"

# Every route of the OpenAPI document, as "METHOD /path/{param}".
document="$(curl -sS "$api/api-json")"
mapfile -t routes < <(jq -r '.paths | to_entries[] | .key as $path | .value | to_entries[]
  | select(.key | IN("get", "put", "post", "delete", "patch")) | "\(.key | ascii_upcase) \($path)"' <<<"$document")
[ "${#routes[@]}" -gt 0 ] || fail "the OpenAPI document lists no routes"

# path_for <template> <function ID>: the path, with its required query parameters filled in.
path_for() {
  local template=$1 method=$2 path name params=()
  path="${template//\{id\}/$3}"
  path="${path//\{functionId\}/$3}"
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
    "POST /functions") jq -cn --arg code "$code" '{name: "l5-b", runtime: "nodejs", code: $code, memory: 128, timeout: 5}' ;;
    "PUT /functions/{id}") echo '{"name": "l5-taken-over"}' ;;
    "POST /functions/{id}/invoke") echo '{"input": {"name": "B"}}' ;;
    "PUT /functions/{id}/scaling-config") echo '{"maxInstances": 1}' ;;
    POST* | PUT* | PATCH*) echo '{}' ;;
  esac
}

echo "== account B, on every route (${#routes[@]})"
own=""
for route in "${routes[@]}" "DELETE /functions/{id} (last)"; do
  method="${route%% *}"
  template="${route#* }"
  case "$route" in
    "DELETE /functions/{id}") continue ;; # last, once everything else is checked
    "DELETE /functions/{id} (last)") template="/functions/{id}" ;;
  esac
  if is_public "$method $template"; then
    as_b "$method" "$(path_for "$template" "$method" "$id")" >/dev/null
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
      check "  ... which A doesn't see" "404 Function with ID $own not found" "$(status) $(jq -r .message "$work/body")"
      ;;
    *'{'*)
      as_b "$method" "$(path_for "$template" "$method" "$id")" "$(body_for "$method" "$template")" >/dev/null
      check "$method $template: B gets 404, as for a missing function" "404 Function with ID $id not found" \
        "$(status) $(jq -r .message "$work/body")"
      ;;
    *) fail "$route: the L5 suite has no rule for this route" ;;
  esac
done
check "A's function, history and limits are unchanged" "$before" "$(snapshot)"
as_b DELETE "/functions/$own" >/dev/null
check "B deletes its own function" 200 "$(status)"

echo "== nobody authenticated, through the guard, on every route (${#routes[@]})"
for route in "${routes[@]}"; do
  method="${route%% *}"
  template="${route#* }"
  anonymous "$method" "$(path_for "$template" "$method" "$id")" "$(body_for "$method" "$template")" >/dev/null
  if is_public "$route"; then
    check "$route: public, 200" 200 "$(status)"
  else
    check "$route: 401" 401 "$(status)"
  fi
done

echo "== users logged in through Keycloak, without an account yet (P-12), on every route"
user_1="l5-$account_a@ff.test"
user_2="l5-$account_b@ff.test"
check "Keycloak creates two users" "201 201" "$(keycloak_user "$user_1") $(keycloak_user "$user_2")"
token_1="$(keycloak_token ff-e2e "$user_1")"
token_2="$(keycloak_token ff-e2e "$user_2")"
[ -n "$token_1" ] && [ "$token_1" != null ] && [ -n "$token_2" ] && [ "$token_2" != null ] ||
  fail "the users could not log in through ff-e2e"
for route in "${routes[@]}"; do
  method="${route%% *}"
  template="${route#* }"
  is_public "$route" && continue
  with_token "$token_1" "$method" "$(path_for "$template" "$method" "$id")" "$(body_for "$method" "$template")" >/dev/null
  check "$route: 403, no account yet" "403 This user has no account yet" "$(status) $(jq -r .message "$work/body")"
done
with_token "$token_2" GET /functions >/dev/null
check "the second user too" "403 This user has no account yet" "$(status) $(jq -r .message "$work/body")"
with_token "${token_1%?????}AAAAA" GET /functions >/dev/null
check "a tampered token: 401" "401 The token is invalid" "$(status) $(jq -r .message "$work/body")"
with_token "$(keycloak_token admin-cli "$user_1")" GET /functions >/dev/null
check "a token meant for another API (Keycloak's admin-cli client): 401" \
  "401 The token is not meant for this API" "$(status) $(jq -r .message "$work/body")"
check "A's function, history and limits are still unchanged" "$before" "$(snapshot)"

echo "$E2E_NAME: $passed checks passed"

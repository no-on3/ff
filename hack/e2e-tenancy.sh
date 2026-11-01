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
#     and one meant for another API, get 401. User 1 chooses English for their
#     e-mails, user 2 keeps French: each approval, and user 2's invitation, come
#     in the reader's language.
#   - API keys (P-13): account 1's key reads and invokes (L4), within its scopes,
#     and stops when revoked; account 2's key gets 404 on account 1's function.
#   - Customers' databases (ADR 0008), on the suite's own server: each account's
#     own; another account gets 404 on every route, and the owner's password
#     still works; a key needs databases:read and databases:write; the
#     operator turns an account's databases off, its user kept out and its
#     members told why, and on again; a closed account's user is kept out,
#     then its database dropped with its data.
#   - Customers' caches (ADR 0013), on the suite's own server: each account's
#     own, their names each account's; another account gets 404 on every
#     route, and the owner's password still works; a key needs caches:read and
#     caches:write; a suspended account's cache refuses its user, then lets it
#     in again, its keys kept; a closed account's is kept out, then deleted.
#   - Buckets and queues, through the S3 front door and the SQS endpoint: each
#     account's key reaches its own account's alone; another's bucket is
#     AccessDenied, another's queue one that doesn't exist, by its URL or its
#     name, and its messages stay.
#   - Members (P-16): user 2 is invited into account 1 and joins on the next call
#     (L4), reads as a viewer, writes as a developer, then is removed; the last
#     owner can't leave. Member routes never reach another account's members.
#   - The audit log (P-17): each account reads its own, which names who did what.
#   - Bank transfers (P-35): an owner asks for a pro-forma, which other accounts
#     never see; the operator finds it by the reference typed from the statement,
#     records the transfer net of a share withheld at source, then uploads the
#     withholding certificate as a raw body with its reason in X-FF-Reason. Each
#     credit reaches the balance, the ledger and the owner's mailbox.
#   - Invoices (P-36): the operator issues last month's invoice, its stamp duty
#     taken from the credit, then a credit note; the owner reads both and the
#     month's usage statement, as PDFs, and other accounts never do.
#   - Notifications: an owner sends a test to a local receiver and to the
#     owners' e-mail; the webhook arrives once, signed with the account's secret
#     as a receiver checks it, the e-mail in the owner's language; a receiver
#     that answers 500 gets the delivery again later; after a rotation, both
#     secrets sign. Each account reads and changes only its own.
# A route without a rule here fails the suite, so a new route can't skip it.
# Same stack as hack/e2e.sh (hack/lib/e2e-stack.sh), plus Keycloak and Mailpit, in
# compose project "ff-e2e-tenancy" (ports 25433 / 29004 / 28180 / 21026 / 28026);
# removed on exit with the namespaces. Its sections run alone too, with what they
# need (hack/lib/sections.sh): --list names them, --only and --from choose. --keep
# removes nothing on exit, for a look and for the next run, which --reuse runs
# against the same stack (hack/lib/e2e-stack.sh says what each keeps).
#   hack/e2e-tenancy.sh [--teardown | --keep] [--reuse] [--list | --only <section>[,<section>…] | --from <section>]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
E2E_PROJECT=ff-e2e-tenancy
E2E_NAME=e2e-tenancy
export FF_PG_PORT="${FF_E2E_TENANCY_PG_PORT:-25433}"
export FF_S3_PORT="${FF_E2E_TENANCY_S3_PORT:-29004}"
export FF_KEYCLOAK_PORT="${FF_E2E_TENANCY_KEYCLOAK_PORT:-28180}"
export FF_MAIL_SMTP_PORT="${FF_E2E_TENANCY_MAIL_SMTP_PORT:-21026}"
export FF_MAIL_UI_PORT="${FF_E2E_TENANCY_MAIL_UI_PORT:-28026}"
source "$FF_REPO_ROOT/hack/lib/e2e-stack.sh"
source "$FF_REPO_ROOT/hack/lib/sections.sh"
sections_options "$@"
e2e_options "${sections_rest[@]}"

account_a="$(random_account)"
account_b="$(random_account)"
e2e_namespaces+=("$(tenant_namespace "$account_a")" "$(tenant_namespace "$account_b")")
api="http://127.0.0.1:$(free_port)"
api_oidc="http://127.0.0.1:$(free_port)"
# Each backend answers function URLs on a port of its own, at http://<id>.fn.localhost:<port>/.
url_port="$(free_port)"
url_port_oidc="$(free_port)"
# And buckets' S3 front door on another, reached path-style at http://127.0.0.1:<port>.
storage_port="$(free_port)"
storage_port_oidc="$(free_port)"
# And queues' SQS endpoint on a third, at http://127.0.0.1:<port>.
sqs_port="$(free_port)"
sqs_port_oidc="$(free_port)"
# Mail's SES endpoint, on the development backend alone, which the accounts' keys are tried at.
ses_port="$(free_port)"
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
# sql <statements>: run in FF's database, nothing printed. sql_value <query> [psql option...]: its rows, unaligned,
# without a header.
sql() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -qc "$1" >/dev/null; }
sql_value() { "${compose[@]}" exec -T postgres psql -U postgres -d serverless_platform -tA "${@:2}" -c "$1"; }
# What waits in a function's queue: its asynchronous calls.
waiting_for() { sql_value "SELECT count(*) FROM queue_messages WHERE function_id = '$1'"; }
# Its messages joined, for an answer that lists them.
messages() { jq -r '.message | if type == "array" then join("; ") else . end' "$work/body"; }
# upload_package <base URL> <zip> [curl arguments]: POST /packages, the zip as the body; its answer, its status in $work/status.
upload_package() {
  local base=$1 file=$2
  shift 2
  curl -sS -o "$work/body" -w '%{http_code}' -X POST -H 'content-type: application/zip' --data-binary @"$file" "$@" "$base/packages" >"$work/status"
  cat "$work/body"
}
sha256_of() { python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.sha256(open(sys.argv[1], "rb").read()).digest()).decode())' "$1"; }
uri() { jq -rn --arg s "$1" '$s | @uri'; }
# Routes anyone may call (@Public()): whether the process is alive, and whether it can serve, for the load balancer.
public_routes=("GET /healthz" "GET /readyz")
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
# keycloak_token <client> <e-mail> [password]: an access token, through the password grant.
keycloak_token() {
  curl -sS -X POST "$keycloak/realms/ff/protocol/openid-connect/token" \
    -d grant_type=password -d "client_id=$1" -d "username=$2" -d "password=${3:-l5-password-1}" -d scope=openid | jq -r .access_token
}
# The development realm's operator (P-70), whose password the realm file sets.
operator_email=operator@ff.test
operator_password=operator-dev-1
# mail_to <address>: the text of the newest e-mail to that address in Mailpit (lines end without \r).
mail_to() {
  local id
  id="$(curl -sS "$mailpit/api/v1/search?query=to:$1" | jq -r '.messages[0].ID // empty')"
  [ -z "$id" ] || curl -sS "$mailpit/api/v1/message/$id" | jq -r '.Subject + "\n" + .Text' | tr -d '\r'
}
# grant <account> <millimes> <key>: promotional credit, written as one balanced ledger transaction
# (P-31), before the operator logs in; the operator's own grants have their section (P-74).
grant() {
  sql "
    INSERT INTO ledger_accounts (account_id, type, currency) VALUES ('$1', 'wallet', 'TND') ON CONFLICT DO NOTHING;
    INSERT INTO ledger_accounts (type, currency) VALUES ('promotional_credit', 'TND') ON CONFLICT DO NOTHING;
    INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('promo', '$3');
    INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor)
      SELECT t.id, a.id, CASE a.type WHEN 'wallet' THEN $2 ELSE -$2 END
        FROM ledger_transactions t, ledger_accounts a
       WHERE t.idempotency_key = '$3' AND a.currency = 'TND'
         AND (a.account_id = '$1' OR (a.account_id IS NULL AND a.type = 'promotional_credit'));"
}
# fetch_pdf <base URL> <path> [curl option...]: GETs a document into $work/file.pdf, its headers into $work/headers, printing its status and content type.
fetch_pdf() {
  local base=$1 path=$2
  shift 2
  curl -sS -D "$work/headers" -o "$work/file.pdf" -w '%{http_code} %{content_type}' "$@" "$base$path"
}
# The file name of the last fetch_pdf's download.
fetched_name() { sed -n 's/^content-disposition: .*filename="\([^"]*\)".*/\1/ip' "$work/headers" | tr -d '\r'; }
# upload <path> <file> [reason]: the operator PUTs a PDF as the body, as the admin dashboard does, its reason URI-encoded in X-FF-Reason (P-35).
upload() {
  local args=(-sS -o "$work/body" -w '%{http_code}' -X PUT -H "Authorization: Bearer $operator_token" -H 'content-type: application/pdf' --data-binary "@$2")
  [ -z "${3:-}" ] || args+=(-H "X-FF-Reason: $(jq -rn --arg reason "$3" '$reason | @uri')")
  curl "${args[@]}" "$api_oidc$1" >"$work/status"
  cat "$work/body"
}
# approve <account...>: the operator approves each one, as the admin dashboard does (P-71).
approve() {
  local account
  for account in "$@"; do
    with_token "$operator_token" POST "/admin/accounts/$account/approve" '{"reason": "l5: use case checked"}' >/dev/null
    [ "$(status)" = 200 ] || fail "the operator could not approve $account: $(status) $(message)"
  done
}

# What more than one section uses: helpers.

# webhooks_to <path>: each request the receiver had on that path, a JSON object per line.
webhooks_to() { jq -c --arg path "$1" 'select(.path == $path)' "$work/webhooks.jsonl"; }

# call_url <function URL> [curl option...]: a GET of the URL; prints the status, and the body goes to $work/url-body.
# --resolve takes the URL's host to this machine, whatever the system's resolver does with *.localhost.
call_url() {
  local url=$1 host port
  shift
  host="${url#http://}"
  port="${host#*:}"
  host="${host%%:*}"
  curl -s -o "$work/url-body" -w '%{http_code}' --resolve "$host:${port%/}:127.0.0.1" "$@" "$url"
}

# function_body <name>: a Node.js function's body, with account A's code.
function_body() { jq -cn --arg code "$code" --arg name "$1" '{name: $name, runtime: "nodejs", code: $code, memory: 128, timeout: 5}'; }

# snapshot <caller> <function ID>: what another account's calls must not change.
snapshot() {
  local caller=$1 fn=$2
  jq -cn --argjson fn "$("$caller" GET "/functions/$fn")" --argjson history "$("$caller" GET "/functions/$fn/invocations")" \
    --argjson url "$("$caller" GET "/functions/$fn/url")" \
    '{name: $fn.name, code: $fn.code, status: $fn.status, memory: $fn.memory, timeout: $fn.timeout, revisionId: $fn.revisionId,
      minInstances: $fn.minInstances, maxInstances: $fn.maxInstances, invocations: $history.total,
      url: $url.functionUrl, urlAuthType: $url.authType}'
}

# proved_domain <account> <domain>: the domain marked proved, as its DKIM record found would prove it.
proved_domain() { sql "UPDATE email_identities SET status = 'SUCCESS', verified_at = now() WHERE account_id = '$1' AND identity = '$2'"; }

# notified_by <as_…> <bucket>: the IDs of the bucket's notification configurations, as its own account reads them.
notified_by() { "$1" GET "/buckets/$2/notifications" | jq -r '[.queueConfigurations[].id] | join(",")'; }

# site_of <as_…> <bucket>: the index document of the bucket's site, as its own account reads it.
site_of() { "$1" GET "/buckets/$2/website" | jq -r '.indexDocument.suffix'; }

# site_domains_of <as_…> <bucket>: the domains of the bucket's site, as its own account reads them.
site_domains_of() { "$1" GET "/buckets/$2/website/domains" | jq -r '[.[].domain] | join(",")'; }

# kept_by <as_…> <queue>: the queue's name and its messages that can be received, as its own account reads them.
kept_by() { "$1" GET "/queues/$2" | jq -r '"\(.name) \(.messages.available)"'; }

# queue_body <route>: a body each queue route takes, so that only the queue's owner decides its answer.
queue_body() {
  case "$1" in
    "PATCH /queues/{name}") echo '{"delaySeconds": 5}' ;;
    "POST /queues/{name}/messages") echo '{"body": "not mine"}' ;;
    POST*) echo '{}' ;;
    *) echo '' ;;
  esac
}

# alarm_body [function ID]: a valid alarm, on that function's errors, or on the account's calls without one.
alarm_body() {
  jq -cn --arg fn "${1:-}" '{name: "l5", functionId: (if $fn == "" then null else $fn end), metric: (if $fn == "" then "Invocations" else "Errors" end),
    statistic: "Sum", period: 60, comparison: "GreaterThanThreshold", threshold: 1000, evaluationPeriods: 1, datapointsToAlarm: 1, actions: {email: false, webhookUrls: []}}'
}

# path_for <template> <method> <function ID> <account ID> [key ID]: the path, with its required query parameters filled in,
# which route_queries has from the API's document.
path_for() {
  local template=$1 method=$2 path name params=()
  case $template in
    /accounts/* | /admin/accounts/*) path="${template//\{id\}/$4}" ;;
    /admin/plans/*) path="${template//\{id\}/beta}" ;;
    /api-keys/*) path="${template//\{id\}/${5:-0123456789ab}}" ;;
    *) path="${template//\{id\}/$3}" ;;
  esac
  path="${path//\{functionId\}/$3}"
  path="${path//\{userId\}/$missing}"
  path="${path//\{invocationId\}/$missing}"
  path="${path//\{domain\}/l5.example.tn}"
  path="${path//\{identity\}/shop.l5.example.tn}" # a domain or an address to send mail from
  path="${path//\{address\}/gone@l5.example.tn}"
  path="${path//\{scheduleId\}/$missing}"
  path="${path//\{version\}/1}" # a function's version: A's first
  [[ $path != *'{month}'* ]] || path="${path//\{month\}/$(date -u +%Y-%m)}"
  [[ $template != /functions/*/aliases/* ]] || path="${path//\{name\}/live}" # A's alias
  path="${path//\{name\}/l5-photos-a}" # a bucket's, or a queue's
  path="${path//\{receiptHandle\}/bm90LWEtaGFuZGxl}"
  path="${path//\{uuid\}/$missing}" # an event source mapping's, which each loop names itself
  [[ $path != *'{'* ]] || fail "$method $template: no value for its path parameter"
  for name in ${route_queries["$method $template"]:-}; do
    case $name in
      start) params+=("start=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)") ;;
      end) params+=("end=$(date -u +%Y-%m-%dT%H:%M:%SZ)") ;;
      q) params+=("q=l5") ;;
      expression) params+=("expression=rate(1%20hour)") ;;
      *) fail "$method $template: no value for its required query parameter $name" ;;
    esac
  done
  local IFS='&'
  printf '%s%s' "$path" "${params:+?${params[*]}}"
}

# body_for <method> <template>: a valid body, so that only the account check can refuse the call.
body_for() {
  case "$1 $2" in
    "POST /functions") function_body l5-other ;;
    "PUT /functions/{id}") echo '{"name": "l5-taken-over"}' ;;
    "POST /functions/{id}/invoke") echo '{"input": {"name": "B"}}' ;;
    "POST /functions/{id}/aliases") echo '{"name": "l5-b", "functionVersion": "1"}' ;;
    "PUT /functions/{id}/aliases/{name}") echo '{"functionVersion": "$LATEST"}' ;;
    "PUT /functions/{id}/scaling-config") echo '{"maxInstances": 1}' ;;
    "PUT /functions/{id}/event-invoke-config") echo '{"maximumRetryAttempts": 0}' ;;
    "POST /functions/{id}/event-sources") echo "{\"eventSourceArn\": \"arn:aws:sqs:tn-tunis-1:$account_a:l5-orders-a\"}" ;;
    "PATCH /functions/{id}/secrets") echo '{"secrets": {"L5_SECRET": "l5"}}' ;;
    "POST /functions/{id}/url" | "PUT /functions/{id}/url") echo '{"authType": "NONE"}' ;;
    "POST /functions/{id}/url/domains" | "POST /buckets/{name}/website/domains") echo '{"domain": "l5.example.tn"}' ;;
    "POST /functions/{id}/schedules" | "PUT /functions/{id}/schedules/{scheduleId}") echo '{"name": "l5", "expression": "rate(1 hour)"}' ;;
    "POST /email/identities") echo '{"identity": "shop.l5.example.tn"}' ;;
    "PUT /email/suppressions/{address}") echo '{"reason": "BOUNCE"}' ;;
    "POST /email/messages") echo '{"from": "orders@shop.l5.example.tn", "to": ["team@shop.l5.example.tn"], "subject": "l5", "text": "l5"}' ;;
    "POST /accounts") echo '{"name": "L5 second account", "useCase": "isolation tests"}' ;;
    "PATCH /accounts/{id}") echo '{"name": "taken over"}' ;;
    "PATCH /me") echo '{"locale": "fr-TN"}' ;;
    "POST /notifications/test") echo "{\"webhookUrl\": \"$receiver/b\"}" ;;
    "POST /alarms" | "PUT /alarms/{id}") alarm_body ;;
    "POST /api-keys") echo '{"name": "l5", "scopes": ["functions:read"]}' ;;
    "POST /members") echo '{"email": "l5-invitee@ff.test", "role": "viewer"}' ;;
    "PUT /admin/settings") echo '{"settings": {"gracePeriodHours": 1}, "reason": "l5 tries"}' ;;
    "PUT /admin/accounts/{id}/plan") echo '{"planId": "beta", "reason": "l5 tries"}' ;;
    "PUT /admin/accounts/{id}/egress") echo '{"internetEgress": true, "reason": "l5 tries"}' ;;
    "PUT /admin/accounts/{id}/storage") echo '{"enabled": false, "reason": "l5 tries"}' ;;
    "PUT /admin/accounts/{id}/email") echo '{"sendingEnabled": false, "reason": "l5 tries"}' ;;
    "POST /admin/accounts/{id}/credits") echo '{"kind": "promo", "amount": "1", "reason": "l5 tries", "idempotencyKey": "00000000-0000-4000-8000-000000000000"}' ;;
    "POST /admin/accounts/"*) echo '{"reason": "l5 tries"}' ;;
    "POST /admin/plans") echo '{"id": "l5-tries", "name": "L5 tries", "limits": {}, "reason": "l5 tries"}' ;;
    "PUT /admin/plans/{id}") echo '{"limits": {}, "reason": "l5 tries"}' ;;
    "POST /admin/price-books") echo '{"validFrom": "2030-01-01T00:00:00Z", "document": {}, "reason": "l5 tries"}' ;;
    "POST /admin/price-books/preview") echo '{"document": {}}' ;;
    "PATCH /members/{userId}") echo '{"role": "viewer"}' ;;
    "PUT /billing/alerts") echo '{"lowBalancePercents": [80, 20]}' ;;
    POST* | PUT* | PATCH*) echo '{}' ;;
  esac
}

# s3_with <key ID> <secret> <port> <aws s3 arguments…>: accepted, or refused with the S3 error's code, as the CLI prints it.
s3_with() {
  local id=$1 secret=$2 port=$3
  shift 3
  AWS_ACCESS_KEY_ID="$id" AWS_SECRET_ACCESS_KEY="$secret" AWS_DEFAULT_REGION=tn-tunis-1 AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    "${aws_cli[@]}" --endpoint-url "http://127.0.0.1:$port" "$@" >/dev/null 2>"$work/s3.err" && echo accepted ||
    echo "refused $(grep -oE '\((SignatureDoesNotMatch|AccessDenied|InvalidAccessKeyId|AccountProblem|NoSuchBucket)\)' "$work/s3.err" | head -1 | tr -d '()')"
}

as_user_1() { with_token "$token_1" "$@"; }

as_user_2() { with_token "$token_2" "$1" "$2" "${3:-}" -H "X-FF-Account: ${account_2:-}"; }

# plus_millimes <amount> <millimes>: the amount, as the API writes TND, plus that many millimes.
plus_millimes() { node -e 'const [a, m] = process.argv.slice(1); console.log(((Math.round(Number(a) * 1000) + Number(m)) / 1000).toFixed(3))' "$1" "$2"; }

# transfer <received> <withheld>: a bank transfer received today, for the pro-forma whose reference was typed.
transfer() { jq -cn --arg reference "$typed" --arg received "$1" --arg withheld "$2" --arg on "$today" \
  '{reference: $reference, received: $received, withheld: $withheld, receivedOn: $on, bankReference: "VIR-L5-1", reason: "l5: statement of today"}'; }

section_stack() {
section "the stack: its database and object storage, Keycloak and Mailpit, the cluster, customers' database, cache and mail servers"
e2e_within_one_month 8
e2e_dependencies keycloak mailpit
e2e_cluster
# Customers' databases (ADR 0008): the suite's own server, on 10.199.2.0/24, which no other run uses.
e2e_data_db 10.199.2.0/24 10.199.2.10
# Customers' caches (ADR 0013): the suite's own server, beside it.
e2e_cache 10.199.2.11
e2e_mail 10.199.2.12 10.199.2.13
}
section_def stack section_stack budget=145

section_receiver() {
section "a webhook receiver, as a customer's: it records each request, and answers 204, or 500 on /fail"
receiver_port="$(free_port)"
receiver="http://127.0.0.1:$receiver_port"
cat >"$work/receiver.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode()
        with open(sys.argv[2], 'a') as out:
            out.write(json.dumps({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body}) + '\n')
        self.send_response(500 if self.path == '/fail' else 204)
        self.end_headers()
    def log_message(self, *args):
        pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), Receiver).serve_forever()
PY
: >"$work/webhooks.jsonl"
python3 "$work/receiver.py" "$receiver_port" "$work/webhooks.jsonl" &
e2e_pids+=("$!")
}
section_def receiver section_receiver stack budget=5

section_backends() {
section "backends"
e2e_build
e2e_migrate "${e2e_base_env[@]}"
# Both backends share the database, so both hear the ledger's NOTIFY, and either may send a low-balance e-mail (P-33): both have the SMTP server.
# Both send notifications every second, and may reach the receiver on this machine.
notify_env=(FF_NOTIFY_INTERVAL_SECONDS=1 FF_WEBHOOK_ALLOW_PRIVATE=true)
e2e_start_backend "$work/backend.log" "$api" "${e2e_base_env[@]}" "${e2e_data_db_env[@]}" "${e2e_cache_env[@]}" "${e2e_mail_env[@]}" PORT="${api##*:}" \
  FF_AUTH_MODE=dev FF_DEV_ACCOUNT_ID="$account_a" FF_SMTP_URL="smtp://localhost:$FF_MAIL_SMTP_PORT" "${notify_env[@]}" \
  FF_FUNCTION_URL_PORT="$url_port" FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port" \
  FF_STORAGE_PORT="$storage_port" FF_STORAGE_BASE="http://s3.localhost:$storage_port" \
  FF_SQS_PORT="$sqs_port" FF_SQS_BASE="http://127.0.0.1:$sqs_port" \
  FF_SES_PORT="$ses_port" FF_SES_BASE="http://127.0.0.1:$ses_port"
# Its deletion job runs every 5 s instead of every hour, so that the last section sees a closed account's data deleted.
e2e_start_backend "$work/backend-oidc.log" "$api_oidc" "${e2e_base_env[@]}" "${e2e_data_db_env[@]}" "${e2e_cache_env[@]}" "${e2e_mail_env[@]}" PORT="${api_oidc##*:}" \
  FF_AUTH_MODE=oidc FF_DEV_ACCOUNT_ID= FF_OIDC_ISSUER="$keycloak/realms/ff" FF_OIDC_AUDIENCE=ff-api \
  FF_SMTP_URL="smtp://localhost:$FF_MAIL_SMTP_PORT" FF_OPERATOR_EMAIL="$operator" FF_ADMIN_URL=http://localhost:5198 \
  FF_RETENTION_INTERVAL_SECONDS=5 "${notify_env[@]}" \
  FF_FUNCTION_URL_PORT="$url_port_oidc" FF_FUNCTION_URL_BASE="http://fn.localhost:$url_port_oidc" \
  FF_STORAGE_PORT="$storage_port_oidc" FF_STORAGE_BASE="http://s3.localhost:$storage_port_oidc" \
  FF_SQS_PORT="$sqs_port_oidc" FF_SQS_BASE="http://127.0.0.1:$sqs_port_oidc"
echo "  accounts A $account_a and B $account_b on $api; OIDC mode on $api_oidc"
}
section_def backends section_backends stack budget=100

section_account_a() {
section "account A's function"
code='export async function handler(event: { name?: string }) {
  return { message: `Hello ${event.name ?? "world"}` };
}'
created="$(as_a POST /functions "$(function_body l5-a)")"
check "A creates a function" "201 ACTIVE" "$(status) $(jq -r .status <<<"$created")"
id="$(jq -r .id <<<"$created")"
as_a POST "/functions/$id/invoke" '{"input":{"name":"A"}}' >/dev/null
check "A invokes it" 201 "$(status)"
check "A's usage counts the call (P-22)" "1" \
  "$(as_a GET /usage | jq -r --arg id "$id" '.functions[] | select(.functionId == $id) | .requests')"
url_a="$(as_a POST "/functions/$id/url" '{"authType": "NONE"}' | jq -r .functionUrl)"
check "A gives its function a URL" "201 true" "$(status) $([[ $url_a =~ ^http://[a-z0-9]{32}\.fn\.localhost:$url_port/$ ]] && echo true || echo false)"
check "which anyone may call: its host reaches A's function" '200 {"message":"Hello world"}' "$(call_url "$url_a") $(cat "$work/url-body")"
version_a="$(as_a POST "/functions/$id/versions" '{"description": "l5"}')"
check "A publishes a version of it, as Lambda's PublishVersion" "201 1 arn:aws:lambda:tn-tunis-1:$account_a:function:l5-a:1" \
  "$(status) $(jq -r '"\(.version) \(.functionArn)"' <<<"$version_a")"
alias_a="$(as_a POST "/functions/$id/aliases" '{"name": "live", "functionVersion": "1"}')"
check "A points its alias live at it, as Lambda's CreateAlias" "201 arn:aws:lambda:tn-tunis-1:$account_a:function:l5-a:live 1" \
  "$(status) $(jq -r '"\(.aliasArn) \(.functionVersion)"' <<<"$alias_a")"
before="$(snapshot as_a "$id")"
database_a="$(as_a POST /databases '{"name": "l5-orders"}')"
check "A makes a database, its password in the answer" "201 active true" "$(status) $(jq -r '"\(.status) \(.connectionString | startswith("postgresql://"))"' <<<"$database_a")"
db_a="$(jq -r .id <<<"$database_a")"
conn_a="$(jq -r .connectionString <<<"$database_a")"
check "  ... which its connection string reaches, over TLS, as its own user" "$(jq -r .user <<<"$database_a")|t" \
  "$(data_db_psql "$conn_a" 'select current_user, ssl from pg_stat_ssl where pid = pg_backend_pid()')"
cache_a="$(as_a POST /caches '{"name": "l5-sessions"}')"
check "A makes a cache, its address with its password in the answer" "201 active true" "$(status) $(jq -r '"\(.status) \(.url | startswith("rediss://default:"))"' <<<"$cache_a")"
cache_url_a="$(jq -r .url <<<"$cache_a")"
cache_port_a="$(jq -r .port <<<"$cache_a")"
cache_cli "$cache_url_a" SET l5 a >/dev/null
check "  ... which its address reaches, over TLS" a "$(cache_cli "$cache_url_a" GET l5)"
identity_a="$(as_a POST /email/identities '{"identity": "Shop.L5.example.tn"}')"
check "A adds a domain to send mail from, pending, with its DKIM record to publish" "201 shop.l5.example.tn PENDING true" \
  "$(status) $(jq -r '"\(.identity) \(.status) \(.records[0].value | startswith("v=DKIM1; k=rsa; p="))"' <<<"$identity_a")"
selector_a="$(jq -r .dkimSelector <<<"$identity_a")"
suppression_a="$(as_a PUT /email/suppressions/gone@l5.example.tn '{"reason": "BOUNCE"}')"
check "  ... and an address to its suppression list" "200 BOUNCE" "$(status) $(jq -r .reason <<<"$suppression_a")"
# Its domain proved, as its DKIM record found would prove it (L4 publishes one): then a message from it.
proved_domain "$account_a" shop.l5.example.tn
message_a="$(as_a POST /email/messages '{"from": "orders@shop.l5.example.tn", "to": ["team@shop.l5.example.tn"], "subject": "l5", "text": "A'"'"'s"}' | jq -r .messageId)"
check "  ... and sends a message from it, once it is proved" 201 "$(status)"
as_a POST /buckets '{"name": "l5-photos-a"}' >/dev/null
check "A makes a bucket" 201 "$(status)"
as_a POST /queues '{"name": "l5-orders-a"}' >/dev/null
check "A makes a queue" 201 "$(status)"
as_a POST /queues/l5-orders-a/messages '{"body": "A'"'"'s own"}' >/dev/null
check "  ... and sends it a message" 201 "$(status)"
mapping_a="$(as_a POST "/functions/$id/event-sources" "{\"eventSourceArn\": \"arn:aws:sqs:tn-tunis-1:$account_a:l5-orders-a\", \"enabled\": false}" | jq -r .uuid)"
check "  ... which A's function is mapped to, disabled: nothing reads the message" 201 "$(status)"
as_a POST /queues '{"name": "l5-events-a"}' >/dev/null
as_a PUT /buckets/l5-photos-a/notifications "{\"queueConfigurations\": [{\"id\": \"l5\", \"queueArn\": \"arn:aws:sqs:tn-tunis-1:$account_a:l5-events-a\", \"events\": [\"s3:ObjectRemoved:*\"]}]}" >/dev/null
check "  ... and A's bucket sends its deletions' events to a queue of A's" "200 l5" "$(status) $(jq -r '.queueConfigurations[0].id' "$work/body")"
as_a PUT /buckets/l5-photos-a/website '{"indexDocument": {"suffix": "index.html"}}' >/dev/null
check "  ... and is a site" "200 index.html" "$(status) $(jq -r '.indexDocument.suffix' "$work/body")"
as_a POST /buckets/l5-photos-a/website/domains '{"domain": "l5.example.tn"}' >/dev/null
check "  ... with a domain of A's own, pending" "201 pending" "$(status) $(jq -r .status "$work/body")"
key_a="$(as_a POST /storage-keys '{}')"
check "  ... and an access key to it, its secret in the answer" "201 true" "$(status) $(jq -r '.secretAccessKey | test("^[A-Za-z0-9+/]{40}$")' <<<"$key_a")"
key_a_id="$(jq -r .id <<<"$key_a")"
key_a_secret="$(jq -r .secretAccessKey <<<"$key_a")"
missing="$(node -e "console.log(require('crypto').randomUUID())")"
as_a GET "/functions/$missing" >/dev/null
check "a function that doesn't exist answers 404" "404 Function with ID $missing not found" "$(status) $(message)"
as_a GET /functions '' -H 'X-FF-Dev-Account: 12345' >/dev/null
check "a malformed X-FF-Dev-Account is refused" 400 "$(status)"

# Every route of the OpenAPI document, as "METHOD /path/{param}", and the query parameters each requires, read once:
# the loops below call every route, and the document is too large to read again for each.
document="$(curl -sS "$api/api-json")"
routes=()
declare -gA route_queries=()
while IFS=$'\t' read -r route queries; do
  routes+=("$route")
  route_queries[$route]="$queries"
done < <(jq -r '.paths | to_entries[] | .key as $path | .value | to_entries[] | select(.key | IN("get", "put", "post", "delete", "patch"))
  | "\(.key | ascii_upcase) \($path)\t\([.value.parameters // [] | .[] | select(.in == "query" and .required) | .name] | join(" "))"' <<<"$document")
[ "${#routes[@]}" -gt 0 ] || fail "the OpenAPI document lists no routes"
# The loops make more changes in a minute than a plan allows, and the rate limit would hold each a minute: the accounts
# they run as, B and 2, are on a plan of the test's own, with beta's limits but that one.
sql "INSERT INTO plans (id, name, limits) SELECT 'l5-loops', 'L5 loops', limits || '{\"writesPerMinute\": 10000}' FROM plans WHERE id = 'beta'"
as_b GET /me >/dev/null # development mode makes B's account on its first call
sql "UPDATE accounts SET plan_id = 'l5-loops' WHERE id = '$account_b'"

needs_user="400 Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage accounts"
needs_user_for_keys="400 Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage API keys"
needs_user_for_members="400 Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage members"
no_operator="400 Development mode has no operator: the admin dashboard needs FF_AUTH_MODE=oidc and an operator's login"
not_admin_client="403 The admin routes take a token issued to the admin dashboard (ff-admin)"
}
section_def account_a section_account_a backends receiver budget=20

section_dev_routes() {
section "development mode, account B, on every route (${#routes[@]})"
grant "$account_a" 3000 "promo:l5-a"
balance_a="$(as_a GET /billing/balance)"
check "A reads its balance: 3.000 TND of credit (P-32)" "200 3.000 TND" "$(status) $(jq -r '"\(.balance) \(.currency)"' <<<"$balance_a")"
check "and the credit among its transactions" "promo 3.000" "$(as_a GET /billing/transactions | jq -r '.transactions[] | "\(.kind) \(.amount)"')"
proforma_a="$(as_a POST /billing/pro-formas '{"credit": "50"}')"
check "A asks for a pro-forma: 50.000 TND of credit, 19% VAT on top, a reference to transfer with (P-35)" "201 pending 50.000 9.500 59.500 true" \
  "$(status) $(jq -r '"\(.status) \(.credit) \(.vat) \(.total) \(.reference | test("^FF-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$"))"' <<<"$proforma_a")"
pf_a="$(jq -r .id <<<"$proforma_a")"
secret_a="$(as_a GET /notifications/webhook-secret | jq -r .secret)"
as_a POST /notifications/test "{\"webhookUrl\": \"$receiver/a\"}" >/dev/null
check "A sends itself a test notification, to the receiver" 202 "$(status)"
alarm_a="$(as_a POST /alarms "$(alarm_body "$id")" | jq -r .id)"
check "A makes an alarm on its function's errors" 201 "$(status)"
# A's package, and another for whoever uploads one in the loops below.
python3 - "$work/package-a.zip" "$work/package-b.zip" <<'PY'
import sys, zipfile
for path, who in zip(sys.argv[1:], 'ab'):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('index.js', 'exports.handler = async () => "%s";\n' % who)
PY
package_a="$(upload_package "$api" "$work/package-a.zip" | jq -r .codeSha256)"
check "A uploads a package" "201 $(sha256_of "$work/package-a.zip")" "$(status) $package_a"
package_b="$(sha256_of "$work/package-b.zip")"
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
    "POST /accounts" | "GET /accounts/{id}" | "PATCH /accounts/{id}" | "PATCH /me")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: needs a logged-in user" "$needs_user" "$(status) $(message)"
      ;;
    "GET /api-keys" | "POST /api-keys" | "DELETE /api-keys/{id}")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: needs a logged-in user" "$needs_user_for_keys" "$(status) $(message)"
      ;;
    "GET /audit-log")
      log_b="$(as_b GET /audit-log)"
      check "$route: B reads its own log, which never names A's function" "200 0" \
        "$(status) $(jq --arg id "function:$id" '[.entries[] | select(.resource == $id)] | length' <<<"$log_b")"
      ;;
    "GET /usage")
      usage_b="$(as_b GET /usage)"
      check "$route: B reads its own usage, which never counts A's function" "200 0" \
        "$(status) $(jq --arg id "$id" '[.functions[] | select(.functionId == $id)] | length' <<<"$usage_b")"
      ;;
    "GET /usage/aws-estimate")
      # A's function was called this month; B called nothing.
      estimate_b="$(as_b GET /usage/aws-estimate)"
      estimate_status="$(status)"
      check "$route: B's estimate at AWS's prices never counts A's calls" "200 0 true" \
        "$estimate_status $(jq '[.months[].requests] | add' <<<"$estimate_b") $(as_a GET /usage/aws-estimate | jq '.months[-1].requests > 0')"
      ;;
    "GET /metrics")
      # A's function was called in the last hour; B called nothing.
      metrics_b="$(as_b GET /metrics)"
      metrics_status="$(status)"
      check "$route: B reads its own metrics, which never count A's calls" "200 0 true" \
        "$metrics_status $(jq -r '[.metrics.Invocations[]] | add' <<<"$metrics_b") $(as_a GET /metrics | jq '[.metrics.Invocations[]] | add > 0')"
      ;;
    "GET /billing/balance")
      balance_b="$(as_b GET /billing/balance)"
      check "$route: B reads its own balance, none of A's credit" "200 0.000" "$(status) $(jq -r .balance <<<"$balance_b")"
      ;;
    "GET /billing/transactions")
      transactions_b="$(as_b GET /billing/transactions)"
      check "$route: B lists none of A's transactions" "200 0" "$(status) $(jq '.transactions | length' <<<"$transactions_b")"
      ;;
    "GET /billing/alerts")
      alerts_b="$(as_b GET /billing/alerts)"
      check "$route: B reads its own shares, FF's (P-33)" "200 null" "$(status) $(jq -c .lowBalancePercents <<<"$alerts_b")"
      ;;
    "PUT /billing/alerts")
      as_b PUT /billing/alerts '{"lowBalancePercents": [80, 20]}' >/dev/null
      check "$route: B sets its own shares (P-33)" 200 "$(status)"
      alerts_a="$(as_a GET /billing/alerts)"
      check "  ... which are not A's" "200 null" "$(status) $(jq -c .lowBalancePercents <<<"$alerts_a")"
      ;;
    "POST /billing/pro-formas")
      pf_b="$(as_b POST /billing/pro-formas '{"credit": "20"}' | jq -r .id)"
      check "$route: B asks for its own pro-forma (P-35)" 201 "$(status)"
      check "  ... which A's list doesn't show: A's has its own only" "$pf_a" "$(as_a GET /billing/pro-formas | jq -r '[.proFormas[].id] | join(" ")')"
      as_a GET "/billing/pro-formas/$pf_b" >/dev/null
      check "  ... nor A reads" "404 Pro-forma $pf_b not found" "$(status) $(message)"
      ;;
    "GET /billing/pro-formas")
      pro_formas_b="$(as_b GET /billing/pro-formas)"
      check "$route: B lists none of A's pro-formas (P-35)" "200 0" "$(status) $(jq --arg id "$pf_a" '[.proFormas[] | select(.id == $id)] | length' <<<"$pro_formas_b")"
      ;;
    "GET /billing/pro-formas/{id}")
      as_b GET "/billing/pro-formas/$pf_a" >/dev/null
      check "$route: B gets 404 for A's pro-forma (P-35)" "404 Pro-forma $pf_a not found" "$(status) $(message)"
      ;;
    "POST /billing/pro-formas/{id}/cancel")
      as_b POST "/billing/pro-formas/$pf_a/cancel" >/dev/null
      check "$route: B can't cancel A's pro-forma: 404 (P-74)" "404 Pro-forma $pf_a not found" "$(status) $(message)"
      check "  ... which stays pending for A" pending "$(as_a GET "/billing/pro-formas/$pf_a" | jq -r .status)"
      ;;
    "GET /billing/invoices")
      invoices_b="$(as_b GET /billing/invoices)"
      check "$route: B lists its own invoices: none (P-36)" "200 0" "$(status) $(jq '.invoices | length' <<<"$invoices_b")"
      ;;
    "GET /billing/invoices/{id}/pdf")
      as_b GET "/billing/invoices/$missing/pdf" >/dev/null
      check "$route: an invoice that isn't B's: 404 (P-36)" "404 Invoice $missing not found" "$(status) $(message)"
      ;;
    "GET /billing/statements/{month}/pdf")
      check "$route: B gets its own usage statement, a PDF (P-36)" "200 application/pdf %PDF-" \
        "$(fetch_pdf "$api" "$(path_for "$template" "$method" "$id" "$account_a")" -H "X-FF-Dev-Account: $account_b") $(head -c 5 "$work/file.pdf")"
      ;;
    *" /members"*)
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: needs a logged-in user" "$needs_user_for_members" "$(status) $(message)"
      ;;
    *" /admin/"*)
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: development mode has no operator" "$no_operator" "$(status) $(message)"
      ;;
    "GET /buckets")
      listed="$(as_b GET /buckets | jq 'map(select(.name == "l5-photos-a")) | length')"
      check "$route: B's list doesn't show A's bucket" "200 0" "$(status) $listed"
      ;;
    "POST /buckets")
      as_b POST /buckets '{"name": "l5-photos-a"}' >/dev/null
      check "$route: B can't take the name of A's bucket: names are FF's once, as on AWS" '409 The bucket name "l5-photos-a" is taken: bucket names are unique across FF, as on AWS' "$(status) $(message)"
      as_b POST /buckets '{"name": "l5-photos-b"}' >/dev/null
      check "  ... and makes one of its own, which A's list doesn't show" "201 0" "$(status) $(as_a GET /buckets | jq 'map(select(.name == "l5-photos-b")) | length')"
      ;;
    "GET /buckets/{name}" | "DELETE /buckets/{name}")
      as_b "$method" /buckets/l5-photos-a >/dev/null
      check "$route: B gets 404 for A's bucket" '404 The account has no bucket named "l5-photos-a"' "$(status) $(message)"
      check "  ... which A still has" "l5-photos-a 200" "$(as_a GET /buckets/l5-photos-a | jq -r .name) $(status)"
      ;;
    "GET /buckets/{name}/notifications" | "PUT /buckets/{name}/notifications")
      as_b "$method" /buckets/l5-photos-a/notifications "$([ "$method" = PUT ] && echo '{}' || true)" >/dev/null
      check "$route: B gets 404 for A's bucket's notifications" '404 The account has no bucket named "l5-photos-a"' "$(status) $(message)"
      check "  ... which A still has, as it set them" "l5 200" "$(notified_by as_a l5-photos-a) $(status)"
      ;;
    "GET /buckets/{name}/website" | "PUT /buckets/{name}/website" | "DELETE /buckets/{name}/website")
      as_b "$method" /buckets/l5-photos-a/website "$([ "$method" = PUT ] && echo '{"indexDocument": {"suffix": "stolen.html"}}' || true)" >/dev/null
      check "$route: B gets 404 for A's bucket's site" '404 The account has no bucket named "l5-photos-a"' "$(status) $(message)"
      check "  ... which A still has, as it set it" "index.html 200" "$(site_of as_a l5-photos-a) $(status)"
      ;;
    "GET /buckets/{name}/website/domains" | "POST /buckets/{name}/website/domains" | "POST /buckets/{name}/website/domains/{domain}/verify" | "DELETE /buckets/{name}/website/domains/{domain}")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: B gets 404 for A's bucket's site's domains" '404 The account has no bucket named "l5-photos-a"' "$(status) $(message)"
      check "  ... which A still has" "l5.example.tn 200" "$(site_domains_of as_a l5-photos-a) $(status)"
      ;;
    "POST /buckets/{name}/website/deploy-keys" | "DELETE /buckets/{name}/website/deploy-keys/{id}")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" >/dev/null
      check "$route: B gets 404 for a deploy's key to A's bucket" '404 The account has no bucket named "l5-photos-a"' "$(status) $(message)"
      ;;
    "GET /buckets/{name}/metrics")
      as_b GET /buckets/l5-photos-a/metrics >/dev/null
      check "$route: B gets 404 for A's bucket's metrics" '404 The account has no bucket l5-photos-a' "$(status) $(message)"
      check "  ... which A reads" "true 200" "$(as_a GET /buckets/l5-photos-a/metrics | jq '.metrics.AllRequests.Sum | type == "array"') $(status)"
      ;;
    "GET /buckets/{name}/website/metrics")
      as_b GET /buckets/l5-photos-a/website/metrics >/dev/null
      check "$route: B gets 404 for A's site's metrics" '404 The account has no bucket l5-photos-a' "$(status) $(message)"
      check "  ... which A reads" "true 200" "$(as_a GET /buckets/l5-photos-a/website/metrics | jq '.metrics.Requests.Sum | type == "array"') $(status)"
      ;;
    "GET /queues")
      listed="$(as_b GET /queues | jq 'map(select(.name == "l5-orders-a")) | length')"
      check "$route: B's list doesn't show A's queue" "200 0" "$(status) $listed"
      ;;
    "POST /queues")
      as_b POST /queues '{"name": "l5-orders-b"}' >/dev/null
      check "$route: B makes a queue of its own, which A's list doesn't show" "201 0" "$(status) $(as_a GET /queues | jq 'map(select(.name == "l5-orders-b")) | length')"
      ;;
    "GET /queues/{name}" | "PATCH /queues/{name}" | "DELETE /queues/{name}" | "POST /queues/{name}/purge" | "POST /queues/{name}/messages" | "POST /queues/{name}/receive")
      as_b "$method" "${template/\{name\}/l5-orders-a}" "$(queue_body "$route")" >/dev/null
      check "$route: B gets 404 for A's queue" '404 The account has no queue named "l5-orders-a"' "$(status) $(message)"
      check "  ... which A still has, its message still there and not received" "l5-orders-a 1 200" "$(kept_by as_a l5-orders-a) $(status)"
      ;;
    "DELETE /queues/{name}/messages/{receiptHandle}")
      as_b DELETE /queues/l5-orders-a/messages/bm90LWEtaGFuZGxl >/dev/null
      check "$route: B gets 404 for A's queue's message" '404 The account has no queue named "l5-orders-a"' "$(status) $(message)"
      check "  ... whose message A still has" "l5-orders-a 1 200" "$(kept_by as_a l5-orders-a) $(status)"
      ;;
    "GET /queues/{name}/metrics")
      as_b GET /queues/l5-orders-a/metrics >/dev/null
      check "$route: B gets 404 for A's queue's metrics" '404 The account has no queue l5-orders-a' "$(status) $(message)"
      check "  ... which A reads" "true 200" "$(as_a GET /queues/l5-orders-a/metrics | jq '.metrics.NumberOfMessagesSent.Sum | type == "array"') $(status)"
      ;;
    "GET /event-sources")
      listed="$(as_b GET /event-sources | jq --arg uuid "$mapping_a" 'map(select(.uuid == $uuid)) | length')"
      check "$route: B's list doesn't show A's function reading A's queue" "200 0" "$(status) $listed"
      check "  ... nor does B find one reading A's queue by its ARN" "0 200" \
        "$(as_b GET "/event-sources?eventSourceArn=$(uri "arn:aws:sqs:tn-tunis-1:$account_a:l5-orders-a")" | jq length) $(status)"
      ;;
    "GET /event-sources/{uuid}" | "PATCH /event-sources/{uuid}" | "DELETE /event-sources/{uuid}")
      as_b "$method" "/event-sources/$mapping_a" "$([ "$method" = PATCH ] && echo '{"enabled": true}' || true)" >/dev/null
      check "$route: B gets 404 for A's mapping" "404 The account has no event source mapping $mapping_a" "$(status) $(message)"
      check "  ... which A still has, disabled" "Disabled 10 200" "$(as_a GET "/event-sources/$mapping_a" | jq -r '"\(.state) \(.batchSize)"') $(status)"
      ;;
    "GET /storage-keys")
      listed="$(as_b GET /storage-keys | jq --arg id "$key_a_id" 'map(select(.id == $id)) | length')"
      check "$route: B's list doesn't show A's key" "200 0" "$(status) $listed"
      ;;
    "POST /storage-keys")
      key_b="$(as_b POST /storage-keys '{}')"
      check "$route: B makes a key of its own, which A's list doesn't show" "201 0" \
        "$(status) $(as_a GET /storage-keys | jq --arg id "$(jq -r .id <<<"$key_b")" 'map(select(.id == $id)) | length')"
      ;;
    "DELETE /storage-keys/{id}")
      as_b DELETE "/storage-keys/$key_a_id" >/dev/null
      check "$route: B can't revoke A's key: 404" "404 The account has no access key $key_a_id" "$(status) $(message)"
      check "  ... which A still has" 1 "$(as_a GET /storage-keys | jq --arg id "$key_a_id" 'map(select(.id == $id)) | length')"
      ;;
    "GET /databases")
      listed="$(as_b GET /databases | jq --arg id "$db_a" 'map(select(.id == $id)) | length')"
      check "$route: B's list doesn't show A's database" "200 0" "$(status) $listed"
      ;;
    "POST /databases")
      db_b="$(as_b POST /databases '{"name": "l5-orders"}' | jq -r .id)"
      check "$route: B makes a database of its own, of the name A's has: names are each account's" 201 "$(status)"
      check "  ... which A's list doesn't show" 0 "$(as_a GET /databases | jq --arg id "$db_b" 'map(select(.id == $id)) | length')"
      ;;
    "GET /databases/{id}" | "DELETE /databases/{id}" | "POST /databases/{id}/password" | "GET /databases/{id}/metrics")
      as_b "$method" "${template//\{id\}/$db_a}" >/dev/null
      check "$route: B gets 404 for A's database" "404 Database $db_a not found" "$(status) $(message)"
      database_now="$(as_a GET "/databases/$db_a")"
      check "  ... which A still has, its password unchanged" "200 active 1" "$(status) $(jq -r .status <<<"$database_now") $(data_db_psql "$conn_a" 'select 1')"
      ;;
    "GET /caches")
      listed="$(as_b GET /caches | jq --argjson port "$cache_port_a" 'map(select(.port == $port)) | length')"
      check "$route: B's list doesn't show A's cache" "200 0" "$(status) $listed"
      ;;
    "POST /caches")
      cache_b="$(as_b POST /caches '{"name": "l5-sessions"}')"
      check "$route: B makes a cache of its own, of the name A's has: names are each account's" "201 true" \
        "$(status) $([ "$(jq -r .port <<<"$cache_b")" != "$cache_port_a" ] && echo true || echo false)"
      check "  ... which A's list doesn't show" 0 "$(as_a GET /caches | jq --argjson port "$(jq -r .port <<<"$cache_b")" 'map(select(.port == $port)) | length')"
      as_b DELETE /caches/l5-sessions >/dev/null
      check "  ... and which B deletes, A's own untouched" "204 a" "$(status) $(cache_cli "$cache_url_a" GET l5)"
      ;;
    "GET /email/identities")
      listed="$(as_b GET /email/identities | jq 'map(select(.dkimSelector == "'"$selector_a"'")) | length')"
      check "$route: B's list doesn't show A's domain" "200 0" "$(status) $listed"
      ;;
    "POST /email/identities")
      as_b POST /email/identities '{"identity": "shop.l5.example.tn"}' >/dev/null
      check "$route: B adds the domain A has, with a DKIM key of its own: identities are each account's" "201 true" \
        "$(status) $([ "$(jq -r .dkimSelector "$work/body")" != "$selector_a" ] && echo true || echo false)"
      as_b DELETE /email/identities/shop.l5.example.tn >/dev/null
      check "  ... and which B deletes, A's own untouched" "204 $selector_a" "$(status) $(as_a GET /email/identities/shop.l5.example.tn | jq -r .dkimSelector)"
      ;;
    "GET /email/identities/{identity}" | "POST /email/identities/{identity}/verify" | "DELETE /email/identities/{identity}")
      as_b "$method" "${template//\{identity\}/shop.l5.example.tn}" >/dev/null
      check "$route: B gets 404 for A's domain" "404 The account has no identity shop.l5.example.tn" "$(status) $(message)"
      kept="$(as_a GET /email/identities/shop.l5.example.tn | jq -r .dkimSelector)"
      check "  ... which A still has, its key unchanged" "200 $selector_a" "$(status) $kept"
      ;;
    "GET /email/account")
      sending="$(as_b GET /email/account | jq -r .sentLast24Hours)"
      check "$route: B reads its own sending, nothing of A's in it" "200 0" "$(status) $sending"
      ;;
    "GET /email/messages")
      listed="$(as_b GET /email/messages | jq '.messages | length')"
      check "$route: B's messages don't show A's" "200 0" "$(status) $listed"
      ;;
    "GET /email/metrics")
      sent="$(as_b GET /email/metrics | jq '[.metrics.Send.Sum[]] | add')"
      check "$route: B's mail's metrics count none of A's" "200 0" "$(status) $sent"
      ;;
    "POST /email/messages")
      as_b POST /email/messages '{"from": "orders@shop.l5.example.tn", "to": ["team@shop.l5.example.tn"], "subject": "l5", "text": "B'"'"'s"}' >/dev/null
      check "$route: B can't send from A's domain, which isn't B's" \
        "400 Email address is not verified. The following identities failed the check in region TN-TUNIS-1: orders@shop.l5.example.tn" "$(status) $(message)"
      check "  ... A's message still A's alone" "$message_a 1" "$(as_a GET /email/messages | jq -r '"\(.messages[0].messageId) \(.messages | length)"')"
      ;;
    "GET /email/suppressions")
      listed="$(as_b GET /email/suppressions | jq '.suppressions | length')"
      check "$route: B's list doesn't show A's address" "200 0" "$(status) $listed"
      ;;
    "PUT /email/suppressions/{address}")
      as_b PUT /email/suppressions/gone@l5.example.tn '{"reason": "COMPLAINT"}' >/dev/null
      check "$route: B puts the address A has on its own list, A's reason untouched" "200 BOUNCE" \
        "$(status) $(as_a GET /email/suppressions | jq -r '.suppressions[] | select(.address == "gone@l5.example.tn") | .reason')"
      as_b DELETE /email/suppressions/gone@l5.example.tn >/dev/null
      check "  ... and which B takes off its list, A's still on A's" "204 1" "$(status) $(as_a GET /email/suppressions | jq '.suppressions | length')"
      ;;
    "DELETE /email/suppressions/{address}")
      as_b DELETE /email/suppressions/gone@l5.example.tn >/dev/null
      check "$route: B gets 404 for A's address" "404 gone@l5.example.tn is not on the account's suppression list" "$(status) $(message)"
      check "  ... which A's list still has" 1 "$(as_a GET /email/suppressions | jq '.suppressions | length')"
      ;;
    "GET /caches/{name}" | "DELETE /caches/{name}" | "POST /caches/{name}/password" | "GET /caches/{name}/metrics")
      as_b "$method" "${template//\{name\}/l5-sessions}" >/dev/null
      check "$route: B gets 404 for A's cache" "404 The account has no cache l5-sessions" "$(status) $(message)"
      cache_now="$(as_a GET /caches/l5-sessions)"
      check "  ... which A still has, its password unchanged" "200 active a" "$(status) $(jq -r .status <<<"$cache_now") $(cache_cli "$cache_url_a" GET l5)"
      ;;
    "GET /alarms/{id}" | "PUT /alarms/{id}" | "DELETE /alarms/{id}")
      as_b "$method" "/alarms/$alarm_a" "$([ "$method" = PUT ] && alarm_body || true)" >/dev/null
      check "$route: B gets 404 for A's alarm" "404 Alarm $alarm_a not found" "$(status) $(message)"
      alarm_now="$(as_a GET "/alarms/$alarm_a")"
      check "  ... which A still has, unchanged" "200 l5 Errors $id" "$(status) $(jq -r '"\(.name) \(.metric) \(.functionId)"' <<<"$alarm_now")"
      ;;
    "GET /functions/{id}/versions" | "POST /functions/{id}/versions" | "GET /functions/{id}/versions/{version}" | "DELETE /functions/{id}/versions/{version}" | \
      "GET /functions/{id}/aliases" | "POST /functions/{id}/aliases" | "GET /functions/{id}/aliases/{name}" | "PUT /functions/{id}/aliases/{name}" | \
      "DELETE /functions/{id}/aliases/{name}")
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: B gets 404, as for a missing function" "404 Function with ID $id not found" "$(status) $(message)"
      versions_now="$(as_a GET "/functions/$id/versions")"
      aliases_now="$(as_a GET "/functions/$id/aliases")"
      check "  ... A's versions and aliases as they were" "1 l5 live:1" \
        "$(jq -r '"\(map(.version) | join(",")) \(.[0].description)"' <<<"$versions_now") $(jq -r 'map("\(.name):\(.functionVersion)") | join(",")' <<<"$aliases_now")"
      ;;
    *'{'*)
      as_b "$method" "$(path_for "$template" "$method" "$id" "$account_a")" "$(body_for "$method" "$template")" >/dev/null
      check "$method $template: B gets 404, as for a missing function" "404 Function with ID $id not found" "$(status) $(message)"
      ;;
    "GET /schedules/next-runs")
      runs_b="$(as_b GET "$(path_for "$template" "$method" "$id" "$account_a")")"
      check "$route: B previews an expression, which reads no account's data" "200 5" "$(status) $(jq '.runs | length' <<<"$runs_b")"
      ;;
    "GET /notifications/webhook-secret")
      secret_b="$(as_b GET /notifications/webhook-secret | jq -r .secret)"
      check "$route: B reads its own signing secret, not A's" "200 true" "$(status) $([ "$secret_b" != "$secret_a" ] && [[ "$secret_b" == whsec_* ]] && echo true || echo false)"
      ;;
    "POST /notifications/webhook-secret/rotate")
      as_b POST /notifications/webhook-secret/rotate >/dev/null
      check "$route: B rotates its own secret, never A's" "200 $secret_a" "$(status) $(as_a GET /notifications/webhook-secret | jq -r .secret)"
      ;;
    "POST /notifications/test")
      test_b="$(as_b POST /notifications/test "$(body_for POST /notifications/test)" | jq -r .notificationId)"
      check "$route: B tests its own webhook" 202 "$(status)"
      check "  ... which A's deliveries don't show" 0 "$(as_a GET /notifications/deliveries | jq --arg id "$test_b" 'map(select(.notificationId == $id)) | length')"
      ;;
    "GET /notifications/deliveries")
      others="$(as_b GET /notifications/deliveries | jq --arg url "$receiver/b" 'map(select(.target != $url)) | length')"
      check "$route: B lists only its own deliveries, none of A's" "200 0" "$(status) $others"
      ;;
    "GET /alarms")
      listed="$(as_b GET /alarms | jq --arg id "$alarm_a" 'map(select(.id == $id)) | length')"
      check "$route: B's list doesn't show A's alarm" "200 0" "$(status) $listed"
      ;;
    "POST /alarms")
      as_b POST /alarms "$(alarm_body "$id")" >/dev/null
      check "$route: B can't watch A's function" "404 Function with ID $id not found" "$(status) $(message)"
      as_b POST /alarms '{"name": "l5", "bucketName": "l5-photos-a", "metric": "5xxErrors", "statistic": "Sum", "period": 60, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' >/dev/null
      check "  ... nor A's bucket" "404 The account has no bucket l5-photos-a" "$(status) $(message)"
      as_b POST /alarms '{"name": "l5", "queueName": "l5-orders-a", "metric": "ApproximateNumberOfMessagesVisible", "statistic": "Maximum", "period": 60, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' >/dev/null
      check "  ... nor A's queue" "404 The account has no queue l5-orders-a" "$(status) $(message)"
      as_b POST /alarms '{"name": "l5", "cacheName": "l5-sessions", "metric": "BytesUsedForCache", "statistic": "Maximum", "period": 3600, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' >/dev/null
      check "  ... nor A's cache" "404 The account has no cache l5-sessions" "$(status) $(message)"
      as_b POST /alarms "$(alarm_body)" >/dev/null
      check "  ... but makes its own account's alarm" 201 "$(status)"
      ;;
    "POST /packages")
      upload_package "$api" "$work/package-b.zip" -H "X-FF-Dev-Account: $account_b" >/dev/null
      check "$route: B uploads a package of its own" 201 "$(status)"
      check "  ... which A's list doesn't show" 0 "$(as_a GET /packages | jq --arg sha "$package_b" 'map(select(.codeSha256 == $sha)) | length')"
      as_b POST /functions "$(jq -n --arg sha "$package_a" '{name: "l5-not-mine", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 128, timeout: 5}')" >/dev/null
      check "  ... and B can't name A's package in a function" \
        "400 The account has no package $package_a: upload it with POST /packages, which answers its SHA-256" "$(status) $(messages)"
      ;;
    "GET /packages")
      listed="$(as_b GET /packages | jq --arg sha "$package_a" 'map(select(.codeSha256 == $sha)) | length')"
      check "$route: B's list doesn't show A's package, nor finds it by its SHA-256" "200 0 0" \
        "$(status) $listed $(as_b GET "/packages?codeSha256=$(uri "$package_a")" | jq length)"
      ;;
    *) fail "$route: the L5 suite has no rule for this route" ;;
  esac
done
for type in Event DryRun; do
  http_at "$api" POST "/functions/$id/invoke" '{"input": {"name": "B"}}' -H "X-FF-Dev-Account: $account_b" -H "X-Amz-Invocation-Type: $type" >/dev/null
  check "POST /functions/{id}/invoke as $type: B's call of A's function answers as for a missing function" "404 Function with ID $id not found" "$(status) $(message)"
done
check "  ... and nothing of B's waits in A's function's queue" 0 "$(waiting_for "$id")"
as_b PUT "/functions/$own/event-invoke-config" "$(jq -cn --arg arn "arn:aws:lambda:tn-tunis-1:$account_a:function:l5-a" '{destinationConfig: {onFailure: {destination: $arn}}}')" >/dev/null
check "B can't name A's function as the destination of its own function's calls" \
  "400 destinationConfig.onFailure.destination must be a function of this account, in tn-tunis-1: arn:aws:lambda:tn-tunis-1:$account_b:function:l5-a" "$(status) $(message)"
# A's queue, as the SQS endpoint makes one: a row of FF's database.
sql "INSERT INTO queues (account_id, name, kind) VALUES ('$account_a', 'l5-records', 'customer')"
as_b PUT "/functions/$own/event-invoke-config" "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$account_a:l5-records" '{destinationConfig: {onFailure: {destination: $arn}}}')" >/dev/null
check "  ... nor A's queue" \
  "400 destinationConfig.onFailure.destination must be a queue of this account, in tn-tunis-1: arn:aws:sqs:tn-tunis-1:$account_b:l5-records" "$(status) $(message)"
as_b PUT "/functions/$own/event-invoke-config" "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$account_b:l5-records" '{destinationConfig: {onFailure: {destination: $arn}}}')" >/dev/null
check "  ... which, under its own account's ARN, is no queue of B's" \
  '400 destinationConfig.onFailure.destination: the account has no queue named "l5-records"' "$(status) $(message)"
sql "DELETE FROM queues WHERE account_id = '$account_a' AND name = 'l5-records'"
as_b POST "/functions/$own/event-sources" "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$account_a:l5-orders-a" '{eventSourceArn: $arn}')" >/dev/null
check "B can't have its own function read A's queue" \
  "400 eventSourceArn must be a queue of this account, in tn-tunis-1: arn:aws:sqs:tn-tunis-1:$account_b:l5-orders-a" "$(status) $(message)"
as_b POST "/functions/$own/event-sources" "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$account_b:l5-orders-a" '{eventSourceArn: $arn}')" >/dev/null
check "  ... which, under its own account's ARN, is no queue of B's" '400 eventSourceArn: the account has no queue named "l5-orders-a"' "$(status) $(message)"
check "  ... and A's message is still there, not received" "l5-orders-a 1 200" "$(kept_by as_a l5-orders-a) $(status)"
as_b PUT /buckets/l5-photos-b/notifications "$(jq -cn --arg arn "arn:aws:sqs:tn-tunis-1:$account_a:l5-events-a" '{queueConfigurations: [{queueArn: $arn, events: ["s3:ObjectCreated:*"]}]}')" >/dev/null
check "B's bucket can't send its events to A's queue" \
  "400 InvalidArgument: A destination must be a queue of the bucket's account, in tn-tunis-1: arn:aws:sqs:tn-tunis-1:$account_a:l5-events-a" "$(status) $(message)"
check "A's function, history and limits are unchanged" "$before" "$(snapshot as_a "$id")"
as_b DELETE "/functions/$own" >/dev/null
check "B deletes its own function" 200 "$(status)"
as_b DELETE "/databases/$db_b" >/dev/null
check "B deletes its own database" 204 "$(status)"
}
section_def dev_routes section_dev_routes account_a budget=30

section_s3_keys() {
section "buckets through the S3 front door: each account's key reaches its own account's buckets alone"
if command -v aws >/dev/null; then aws_cli=(aws); else
  aws_cli=(docker run --rm --network host -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION -e AWS_CONFIG_FILE -e AWS_SHARED_CREDENTIALS_FILE amazon/aws-cli:2.34.32)
fi
key_b_id="$(jq -r .id <<<"$key_b")"
key_b_secret="$(jq -r .secretAccessKey <<<"$key_b")"
check "A's key lists A's bucket, and B's key B's" "accepted accepted" \
  "$(s3_with "$key_a_id" "$key_a_secret" "$storage_port" s3 ls s3://l5-photos-a) $(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3 ls s3://l5-photos-b)"
check "A's key on B's bucket, and B's on A's, AccessDenied, both ways" "refused AccessDenied refused AccessDenied" \
  "$(s3_with "$key_a_id" "$key_a_secret" "$storage_port" s3 ls s3://l5-photos-b) $(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3 ls s3://l5-photos-a)"
check "  ... and a copy from the other's bucket too" "refused AccessDenied" \
  "$(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3api copy-object --bucket l5-photos-b --key stolen.txt --copy-source l5-photos-a/anything.txt)"
check "ListBuckets lists each key's own account's buckets alone" "l5-photos-a" \
  "$(AWS_ACCESS_KEY_ID="$key_a_id" AWS_SECRET_ACCESS_KEY="$key_a_secret" AWS_DEFAULT_REGION=tn-tunis-1 AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null "${aws_cli[@]}" --endpoint-url "http://127.0.0.1:$storage_port" s3api list-buckets --query 'Buckets[].Name' --output text)"
check "B's key can neither read nor set A's bucket's notifications, which A still has" "refused AccessDenied refused AccessDenied l5" \
  "$(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3api get-bucket-notification-configuration --bucket l5-photos-a) \
$(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3api put-bucket-notification-configuration --bucket l5-photos-a --notification-configuration '{}') \
$(notified_by as_a l5-photos-a)"
check "B's key can neither read, set nor remove A's bucket's site, which A still has" "refused AccessDenied refused AccessDenied refused AccessDenied index.html" \
  "$(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3api get-bucket-website --bucket l5-photos-a) \
$(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3api put-bucket-website --bucket l5-photos-a --website-configuration '{"IndexDocument": {"Suffix": "stolen.html"}}') \
$(s3_with "$key_b_id" "$key_b_secret" "$storage_port" s3api delete-bucket-website --bucket l5-photos-a) \
$(site_of as_a l5-photos-a)"
as_b DELETE /buckets/l5-photos-b >/dev/null
check "B deletes its own bucket" 204 "$(status)"
}
section_def s3_keys section_s3_keys dev_routes budget=25

section_sqs_keys() {
section "queues through the SQS endpoint: each account's key reaches its own account's queues alone"
# sqs_with <key ID> <secret> <aws sqs arguments…>: the answer's text, or refused with the error's query code, as the CLI prints it.
sqs_with() {
  local id=$1 secret=$2
  shift 2
  AWS_ACCESS_KEY_ID="$id" AWS_SECRET_ACCESS_KEY="$secret" AWS_DEFAULT_REGION=tn-tunis-1 AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    "${aws_cli[@]}" --endpoint-url "http://127.0.0.1:$sqs_port" sqs "$@" --output text 2>"$work/sqs.err" ||
    echo "refused $(grep -oE '\((AWS\.SimpleQueueService\.[A-Za-z]+|SignatureDoesNotMatch|InvalidClientTokenId|AccessDenied)\)' "$work/sqs.err" | head -1 | tr -d '()')"
}
queue_a="$(sqs_with "$key_a_id" "$key_a_secret" create-queue --queue-name l5-orders --query QueueUrl)"
queue_b="$(sqs_with "$key_b_id" "$key_b_secret" create-queue --queue-name l5-orders --query QueueUrl)"
check "each account makes a queue of the same name, its own, under its account" "http://127.0.0.1:$sqs_port/$account_a/l5-orders http://127.0.0.1:$sqs_port/$account_b/l5-orders" \
  "$queue_a $queue_b"
sqs_with "$key_a_id" "$key_a_secret" send-message --queue-url "$queue_a" --message-body "A's own" --query MessageId >/dev/null
check "A's key on B's queue, and B's on A's, a queue that doesn't exist, both ways" \
  "refused AWS.SimpleQueueService.NonExistentQueue refused AWS.SimpleQueueService.NonExistentQueue" \
  "$(sqs_with "$key_a_id" "$key_a_secret" send-message --queue-url "$queue_b" --message-body 'not mine' --query MessageId) $(sqs_with "$key_b_id" "$key_b_secret" receive-message --queue-url "$queue_a" --query 'Messages[].Body')"
check "  ... nor by its name, naming its owner" "refused AWS.SimpleQueueService.NonExistentQueue" \
  "$(sqs_with "$key_b_id" "$key_b_secret" get-queue-url --queue-name l5-orders --queue-owner-aws-account-id "$account_a" --query QueueUrl)"
check "  ... nor purged, nor deleted: A's message is there still" "refused AWS.SimpleQueueService.NonExistentQueue refused AWS.SimpleQueueService.NonExistentQueue A's own" \
  "$(sqs_with "$key_b_id" "$key_b_secret" purge-queue --queue-url "$queue_a") $(sqs_with "$key_b_id" "$key_b_secret" delete-queue --queue-url "$queue_a") $(sqs_with "$key_a_id" "$key_a_secret" receive-message --queue-url "$queue_a" --query 'Messages[].Body')"
# Each lists its own: this queue, and the one its account made through FF's API above.
listed_by() { sqs_with "$1" "$2" list-queues --query QueueUrls | tr '\t' ' '; }
check "ListQueues lists each key's own account's queues alone" \
  "http://127.0.0.1:$sqs_port/$account_a/l5-events-a $queue_a http://127.0.0.1:$sqs_port/$account_a/l5-orders-a $queue_b http://127.0.0.1:$sqs_port/$account_b/l5-orders-b" \
  "$(listed_by "$key_a_id" "$key_a_secret") $(listed_by "$key_b_id" "$key_b_secret")"
sqs_with "$key_a_id" "$key_a_secret" delete-queue --queue-url "$queue_a" >/dev/null
sqs_with "$key_b_id" "$key_b_secret" delete-queue --queue-url "$queue_b" >/dev/null
check "each deletes its own queue" "http://127.0.0.1:$sqs_port/$account_a/l5-events-a http://127.0.0.1:$sqs_port/$account_a/l5-orders-a http://127.0.0.1:$sqs_port/$account_b/l5-orders-b" \
  "$(listed_by "$key_a_id" "$key_a_secret") $(listed_by "$key_b_id" "$key_b_secret")"
}
section_def sqs_keys section_sqs_keys s3_keys budget=25

section_ses_keys() {
section "mail through the SES endpoint: each account's key reaches its own account's identities and sends from them alone"
# ses_with <key ID> <secret> <aws sesv2 arguments…>: the answer's text, or refused with the error's name, as the CLI prints it.
ses_with() {
  local id=$1 secret=$2
  shift 2
  AWS_ACCESS_KEY_ID="$id" AWS_SECRET_ACCESS_KEY="$secret" AWS_DEFAULT_REGION=tn-tunis-1 AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    "${aws_cli[@]}" --endpoint-url "http://127.0.0.1:$ses_port" sesv2 "$@" --output text 2>"$work/ses.err" ||
    echo "refused $(grep -oE 'An error occurred \([A-Za-z]+\)' "$work/ses.err" | head -1 | sed -E 's/.*\((.*)\)/\1/')"
}
check "B's key finds A's domain, made through FF's API, not there: each account's identities are its own" "refused NotFoundException" \
  "$(ses_with "$key_b_id" "$key_b_secret" get-email-identity --email-identity shop.l5.example.tn --query IdentityType)"
check "  ... nor deletes it: A's key reads it still" "refused NotFoundException DOMAIN" \
  "$(ses_with "$key_b_id" "$key_b_secret" delete-email-identity --email-identity shop.l5.example.tn) $(ses_with "$key_a_id" "$key_a_secret" get-email-identity --email-identity shop.l5.example.tn --query IdentityType)"
check "  ... nor reads A's suppressed address, nor takes it off A's list" "refused NotFoundException refused NotFoundException BOUNCE" \
  "$(ses_with "$key_b_id" "$key_b_secret" get-suppressed-destination --email-address gone@l5.example.tn --query SuppressedDestination.Reason) \
$(ses_with "$key_b_id" "$key_b_secret" delete-suppressed-destination --email-address gone@l5.example.tn) \
$(ses_with "$key_a_id" "$key_a_secret" get-suppressed-destination --email-address gone@l5.example.tn --query SuppressedDestination.Reason)"
check "ListEmailIdentities lists each key's own account's identities alone" "shop.l5.example.tn 0" \
  "$(ses_with "$key_a_id" "$key_a_secret" list-email-identities --query 'EmailIdentities[].IdentityName') $(ses_with "$key_b_id" "$key_b_secret" list-email-identities --query 'length(EmailIdentities)')"
ses_message='{"Simple": {"Subject": {"Data": "l5"}, "Body": {"Text": {"Data": "l5"}}}}'
check "SendEmail: B's key can't send from A's domain, which isn't B's; A's key can, the message A's alone" "refused MessageRejected true 0" \
  "$(ses_with "$key_b_id" "$key_b_secret" send-email --from-email-address orders@shop.l5.example.tn --destination ToAddresses=team@shop.l5.example.tn --content "$ses_message") \
$([[ "$(ses_with "$key_a_id" "$key_a_secret" send-email --from-email-address orders@shop.l5.example.tn --destination ToAddresses=team@shop.l5.example.tn --content "$ses_message" --query MessageId)" =~ ^[0-9a-f-]{36}$ ]] && echo true || echo false) \
$(as_b GET /email/messages | jq '.messages | length')"
}
section_def ses_keys section_ses_keys s3_keys budget=15

section_anonymous() {
section "nobody authenticated, through the guard, on every route (${#routes[@]})"
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
}
section_def anonymous section_anonymous account_a budget=10

section_signup() {
section "sign-up: Keycloak's form, e-mail verification through Mailpit, a pending account"
user_1="l5-$account_a@ff.test"
user_2="l5-$account_b@ff.test"
check "user 1 registers, verifies the address and sets a password, back to the console with a code" true \
  "$([[ "$(keycloak_register "$user_1")" == http://localhost:5199/?*code=* ]] && echo true || echo false)"
check "user 2 is made through the admin API" 201 "$(keycloak_user "$user_2")"
token_1="$(keycloak_token ff-e2e "$user_1")"
token_2="$(keycloak_token ff-e2e "$user_2")"
[ -n "$token_1" ] && [ "$token_1" != null ] && [ -n "$token_2" ] && [ "$token_2" != null ] ||
  fail "the users could not log in through ff-e2e"

me_1="$(as_user_1 GET /me)"
check "the backend creates user 1 on the first call, with no account" "200 $user_1 []" \
  "$(status) $(jq -r '"\(.user.email) \(.accounts)"' <<<"$me_1")"
as_user_1 PATCH /me '{"locale": "de"}' >/dev/null
check "a user's e-mails are in French or in English" "400 locale must be one of fr-TN, en" "$(status) $(jq -r '.message[0]' "$work/body")"
as_user_1 PATCH /me '{"locale": "en"}' >/dev/null
check "user 1 chooses English for their e-mails, which are in French at first" "fr-TN 200 en" \
  "$(jq -r .user.locale <<<"$me_1") $(status) $(as_user_1 GET /me | jq -r .user.locale)"
as_user_1 GET /functions >/dev/null
check "without an account, account routes say how to make one" \
  "403 This user has no account yet: create one with POST /accounts" "$(status) $(message)"
account_1="$(as_user_1 POST /accounts '{"name": "L5 one", "useCase": "isolation tests"}' | jq -r .id)"
check "user 1 creates an account: pending, and its owner" "201 pending owner" \
  "$(status) $(as_user_1 GET "/accounts/$account_1" | jq -r '"\(.status) \(.role)"')"
check "you get an e-mail to approve it" true \
  "$(mail_to "$operator" | grep "($account_1)" >/dev/null && mail_to "$operator" | grep 'http://localhost:5198/accounts?status=pending' >/dev/null && echo true || echo false)"
as_user_1 POST /accounts '{"name": "L5 again"}' >/dev/null
check "one account at a time waits for approval" "400 You already have an account waiting for approval" "$(status) $(message)"
as_user_1 POST /functions "$(function_body l5-one)" >/dev/null
check "a pending account can't deploy" \
  "403 Your account is waiting for approval: you can deploy and invoke functions once it is approved" "$(status) $(message)"
account_2="$(with_token "$token_2" POST /accounts '{"name": "L5 two"}' | jq -r .id)"
check "user 2 creates an account" 201 "$(status)"
sql "UPDATE accounts SET plan_id = 'l5-loops' WHERE id = '$account_2'" # for its loop over every route, as B's
e2e_namespaces+=("$(tenant_namespace "$account_1")" "$(tenant_namespace "$account_2")")
operator_token="$(keycloak_token ff-admin "$operator_email" "$operator_password")"
queue="$(with_token "$operator_token" GET '/admin/accounts?status=pending')"
check "both wait in the operator's approvals queue, with who signed up and what for (P-71)" "200 2 isolation tests $user_1" \
  "$(status) $(jq -r --arg a "$account_1" --arg b "$account_2" '[.accounts[] | select(.id == $a or .id == $b)] | length' <<<"$queue") $(jq -r --arg id "$account_1" '.accounts[] | select(.id == $id) | "\(.useCase) \(.owners[0].email)"' <<<"$queue")"
approve "$account_1" "$account_2"
check "the operator approves them, and the owner gets an e-mail that says so" "active Your FF account is approved: L5 one" \
  "$(as_user_1 GET "/accounts/$account_1" | jq -r .status) $(mail_to "$user_1" | head -1)"
check "user 2, whose e-mails are in French, gets theirs in French" "Votre compte FF est approuvé : L5 two" "$(mail_to "$user_2" | head -1)"

created="$(as_user_1 POST /functions "$(function_body l5-one)")"
check "approved, account 1 deploys a function" "201 ACTIVE $account_1" \
  "$(status) $(jq -r '"\(.status) \(.accountId)"' <<<"$created")"
fn_1="$(jq -r .id <<<"$created")"
as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"name":"one"}}' >/dev/null
check "and invokes it" 201 "$(status)"
# PostgreSQL stores no NUL in text: refused with a 400 naming it, never the database's 500.
as_user_1 POST /functions "$(jq -cn '{name: "l5-nul", runtime: "nodejs", code: "export const handler = async () => \"a\u0000b\";", memory: 128, timeout: 5}')" >/dev/null
check "code with a NUL character is refused, named, and nothing is created" "400 code must not contain the NUL character (U+0000) 1" \
  "$(status) $(jq -r '.message[0]' "$work/body") $(as_user_1 GET /functions | jq length)"
as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"text":"a\u0000b"}}' >/dev/null
check "but an invocation's input reaches the function whole" 201 "$(status)"
key_1="$(as_user_1 POST /api-keys '{"name": "l5 reader", "scopes": ["functions:read", "functions:invoke"]}' | jq -r .key)"
check "account 1's owner creates an API key, shown once" "201 true" "$(status) $([[ $key_1 =~ ^ffk_[0-9a-f]{12}_ ]] && echo true || echo false)"
key_1_id="$(cut -d_ -f2 <<<"$key_1")"
invitation_1="$(as_user_1 POST /members '{"email": "l5-someone@ff.test", "role": "viewer"}' | jq -r .id)"
check "account 1's owner invites someone" 201 "$(status)"
user_1_id="$(jq -r .user.id <<<"$me_1")"
before_1="$(snapshot as_user_1 "$fn_1")"
name_1="$(as_user_1 GET "/accounts/$account_1" | jq -r .name)"
members_1="$(as_user_1 GET /members | jq -c '{members: [.members[].email], invitations: [.invitations[].email]}')"

proforma_1="$(as_user_1 POST /billing/pro-formas '{"credit": "50.000"}')"
check "account 1's owner asks for a pro-forma (P-35)" "201 pending 59.500 L5 one" "$(status) $(jq -r '"\(.status) \(.total) \(.buyer.name)"' <<<"$proforma_1")"
pf_1="$(jq -r .id <<<"$proforma_1")"
ref_1="$(jq -r .reference <<<"$proforma_1")"

grant "$account_1" 5000 "promo:l5-1"
}
section_def signup section_signup account_a budget=20

section_isolation() {
section "account 2, on account 1's function and account, on every route (${#routes[@]})"
alarm_1="$(as_user_1 POST /alarms "$(alarm_body "$fn_1")" | jq -r .id)"
check "account 1's owner makes an alarm on its function's errors" 201 "$(status)"
package_1="$(upload_package "$api_oidc" "$work/package-a.zip" -H "Authorization: Bearer $token_1" | jq -r .codeSha256)"
check "account 1's owner uploads a package" "201 $package_a" "$(status) $package_1"
database_1="$(as_user_1 POST /databases '{"name": "l5-one"}')"
check "account 1's owner makes a database" "201 active" "$(status) $(jq -r .status <<<"$database_1")"
db_1="$(jq -r .id <<<"$database_1")"
conn_1="$(jq -r .connectionString <<<"$database_1")"
cache_1="$(as_user_1 POST /caches '{"name": "l5-one"}')"
check "account 1's owner makes a cache" "201 active" "$(status) $(jq -r .status <<<"$cache_1")"
cache_conn_1="$(jq -r .url <<<"$cache_1")"
cache_port_1="$(jq -r .port <<<"$cache_1")"
cache_cli "$cache_conn_1" SET l5 one >/dev/null
identity_1="$(as_user_1 POST /email/identities '{"identity": "shop.l5.example.tn"}')"
check "account 1's owner adds a domain to send mail from" "201 PENDING" "$(status) $(jq -r .status <<<"$identity_1")"
selector_1="$(jq -r .dkimSelector <<<"$identity_1")"
as_user_1 PUT /email/suppressions/gone@l5.example.tn '{"reason": "BOUNCE"}' >/dev/null
check "  ... and an address to its suppression list" 200 "$(status)"
proved_domain "$account_1" shop.l5.example.tn
message_1="$(as_user_1 POST /email/messages '{"from": "orders@shop.l5.example.tn", "to": ["team@shop.l5.example.tn"], "subject": "l5", "text": "account 1'"'"'s"}' | jq -r .messageId)"
check "  ... and sends a message from it, once it is proved" 201 "$(status)"
as_user_1 POST /buckets '{"name": "l5-photos-1"}' >/dev/null
check "account 1's owner makes a bucket" 201 "$(status)"
as_user_1 POST /queues '{"name": "l5-orders-1"}' >/dev/null
check "account 1's owner makes a queue" 201 "$(status)"
as_user_1 POST /queues/l5-orders-1/messages '{"body": "account 1'"'"'s own"}' >/dev/null
check "  ... and sends it a message" 201 "$(status)"
mapping_1="$(as_user_1 POST "/functions/$fn_1/event-sources" "{\"eventSourceArn\": \"arn:aws:sqs:tn-tunis-1:$account_1:l5-orders-1\", \"enabled\": false}" | jq -r .uuid)"
check "  ... which its function is mapped to, disabled" 201 "$(status)"
as_user_1 POST /queues '{"name": "l5-events-1"}' >/dev/null
as_user_1 PUT /buckets/l5-photos-1/notifications "{\"queueConfigurations\": [{\"id\": \"l5-one\", \"queueArn\": \"arn:aws:sqs:tn-tunis-1:$account_1:l5-events-1\", \"events\": [\"s3:ObjectRemoved:*\"]}]}" >/dev/null
check "  ... and its bucket sends its deletions' events to a queue of its own" "200 l5-one" "$(status) $(jq -r '.queueConfigurations[0].id' "$work/body")"
as_user_1 PUT /buckets/l5-photos-1/website '{"indexDocument": {"suffix": "index.html"}, "singlePageApp": true}' >/dev/null
check "  ... and is a single-page app's site" "200 true" "$(status) $(jq -r .singlePageApp "$work/body")"
as_user_1 POST /buckets/l5-photos-1/website/domains '{"domain": "l5-one.example.tn"}' >/dev/null
check "  ... with a domain of its own, pending" "201 pending" "$(status) $(jq -r .status "$work/body")"
key_1_s3="$(as_user_1 POST /storage-keys '{}')"
check "  ... and an access key to it" 201 "$(status)"
key_1_s3_id="$(jq -r .id <<<"$key_1_s3")"
key_1_s3_secret="$(jq -r .secretAccessKey <<<"$key_1_s3")"
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
    "PATCH /me")
      as_user_2 PATCH /me "$(body_for PATCH /me)" >/dev/null
      check "$route: user 2 changes their own e-mails' language, never user 1's" "200 fr-TN en" \
        "$(status) $(as_user_2 GET /me | jq -r .user.locale) $(as_user_1 GET /me | jq -r .user.locale)"
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
      key_2="$(as_user_2 POST /api-keys '{"name": "l5 two", "scopes": ["functions:read", "functions:write", "functions:invoke", "logs:read", "metrics:read"]}' | jq -r .key)"
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
    "GET /audit-log")
      log_2="$(as_user_2 GET /audit-log)"
      check "$route: account 2's log names nothing of account 1's" "200 0" \
        "$(status) $(jq --arg f "function:$fn_1" --arg k "api_key:$key_1_id" --arg i "invitation:$invitation_1" \
          '[.entries[] | select(.resource == $f or .resource == $k or .resource == $i)] | length' <<<"$log_2")"
      ;;
    "GET /usage")
      usage_2="$(as_user_2 GET /usage)"
      check "$route: account 2's usage never counts account 1's function" "200 0" \
        "$(status) $(jq --arg id "$fn_1" '[.functions[] | select(.functionId == $id)] | length' <<<"$usage_2")"
      ;;
    "GET /usage/aws-estimate")
      estimate_2="$(as_user_2 GET /usage/aws-estimate)"
      estimate_status="$(status)"
      check "$route: account 2's estimate at AWS's prices never counts account 1's calls" "200 0 true" \
        "$estimate_status $(jq '[.months[].requests] | add' <<<"$estimate_2") $(as_user_1 GET /usage/aws-estimate | jq '.months[-1].requests > 0')"
      ;;
    "GET /metrics")
      metrics_2="$(as_user_2 GET /metrics)"
      metrics_status="$(status)"
      check "$route: account 2's metrics never count account 1's calls" "200 0 true" \
        "$metrics_status $(jq -r '[.metrics.Invocations[]] | add' <<<"$metrics_2") $(as_user_1 GET /metrics | jq '[.metrics.Invocations[]] | add > 0')"
      ;;
    "GET /billing/balance")
      balance_2="$(as_user_2 GET /billing/balance)"
      check "$route: account 2's balance has none of account 1's credit" "200 0.000" "$(status) $(jq -r .balance <<<"$balance_2")"
      ;;
    "GET /billing/transactions")
      transactions_2="$(as_user_2 GET /billing/transactions)"
      check "$route: account 2 lists none of account 1's transactions" "200 0" "$(status) $(jq '.transactions | length' <<<"$transactions_2")"
      ;;
    "GET /billing/alerts")
      alerts_2="$(as_user_2 GET /billing/alerts)"
      check "$route: account 2's shares are its own (P-33)" "200 null" "$(status) $(jq -c .lowBalancePercents <<<"$alerts_2")"
      ;;
    "PUT /billing/alerts")
      as_user_2 PUT /billing/alerts '{"lowBalancePercents": [90]}' >/dev/null
      check "$route: user 2 sets account 2's shares (P-33)" 200 "$(status)"
      alerts_1="$(as_user_1 GET /billing/alerts)"
      check "  ... and account 1 keeps FF's" "200 null" "$(status) $(jq -c .lowBalancePercents <<<"$alerts_1")"
      ;;
    "POST /billing/pro-formas")
      pf_2="$(as_user_2 POST /billing/pro-formas '{"credit": "20"}' | jq -r .id)"
      check "$route: user 2 asks for account 2's own pro-forma (P-35)" 201 "$(status)"
      check "  ... which account 1's list doesn't show" "$pf_1" "$(as_user_1 GET /billing/pro-formas | jq -r '[.proFormas[].id] | join(" ")')"
      ;;
    "GET /billing/pro-formas")
      pro_formas_2="$(as_user_2 GET /billing/pro-formas)"
      check "$route: account 2 lists none of account 1's pro-formas (P-35)" "200 0" "$(status) $(jq --arg id "$pf_1" '[.proFormas[] | select(.id == $id)] | length' <<<"$pro_formas_2")"
      ;;
    "GET /billing/pro-formas/{id}")
      as_user_2 GET "/billing/pro-formas/$pf_1" >/dev/null
      check "$route: account 1's pro-forma is not found for account 2 (P-35)" "404 Pro-forma $pf_1 not found" "$(status) $(message)"
      ;;
    "POST /billing/pro-formas/{id}/cancel")
      as_user_2 POST "/billing/pro-formas/$pf_1/cancel" >/dev/null
      check "$route: account 2 can't cancel account 1's pro-forma: 404 (P-74)" "404 Pro-forma $pf_1 not found" "$(status) $(message)"
      check "  ... which stays pending" pending "$(as_user_1 GET "/billing/pro-formas/$pf_1" | jq -r .status)"
      ;;
    "GET /billing/invoices")
      invoices_2="$(as_user_2 GET /billing/invoices)"
      check "$route: account 2 lists its own invoices: none (P-36)" "200 0" "$(status) $(jq '.invoices | length' <<<"$invoices_2")"
      ;;
    "GET /billing/invoices/{id}/pdf")
      as_user_2 GET "/billing/invoices/$missing/pdf" >/dev/null
      check "$route: an invoice that isn't account 2's: 404 (P-36)" "404 Invoice $missing not found" "$(status) $(message)"
      ;;
    "GET /billing/statements/{month}/pdf")
      check "$route: account 2 gets its own usage statement, a PDF (P-36)" "200 application/pdf %PDF-" \
        "$(fetch_pdf "$api_oidc" "$(path_for "$template" "$method" "$fn_1" "$account_1")" -H "Authorization: Bearer $token_2" -H "X-FF-Account: $account_2") $(head -c 5 "$work/file.pdf")"
      ;;
    *" /admin/"*)
      as_user_2 "$method" "$(path_for "$template" "$method" "$fn_1" "$account_1")" "$(body_for "$method" "$template")" >/dev/null
      check "$route: a customer's token is not the admin dashboard's" "$not_admin_client" "$(status) $(message)"
      ;;
    "DELETE /members/invitations/{id}")
      as_user_2 DELETE "/members/invitations/$invitation_1" >/dev/null
      check "$route: account 2 can't cancel account 1's invitation" "404 Invitation $invitation_1 not found" "$(status) $(message)"
      ;;
    "GET /buckets")
      listed="$(as_user_2 GET /buckets | jq 'map(select(.name == "l5-photos-1")) | length')"
      check "$route: account 2's list doesn't show account 1's bucket" "200 0" "$(status) $listed"
      ;;
    "POST /buckets")
      as_user_2 POST /buckets '{"name": "l5-photos-1"}' >/dev/null
      check "$route: account 2 can't take the name of account 1's bucket" '409 The bucket name "l5-photos-1" is taken: bucket names are unique across FF, as on AWS' "$(status) $(message)"
      as_user_2 POST /buckets '{"name": "l5-photos-2"}' >/dev/null
      check "  ... and makes one of its own, which account 1's list doesn't show" "201 0" "$(status) $(as_user_1 GET /buckets | jq 'map(select(.name == "l5-photos-2")) | length')"
      ;;
    "GET /buckets/{name}" | "DELETE /buckets/{name}")
      as_user_2 "$method" /buckets/l5-photos-1 >/dev/null
      check "$route: account 2 gets 404 for account 1's bucket" '404 The account has no bucket named "l5-photos-1"' "$(status) $(message)"
      check "  ... which account 1 still has" "l5-photos-1 200" "$(as_user_1 GET /buckets/l5-photos-1 | jq -r .name) $(status)"
      ;;
    "GET /buckets/{name}/notifications" | "PUT /buckets/{name}/notifications")
      as_user_2 "$method" /buckets/l5-photos-1/notifications "$([ "$method" = PUT ] && echo '{}' || true)" >/dev/null
      check "$route: account 2 gets 404 for account 1's bucket's notifications" '404 The account has no bucket named "l5-photos-1"' "$(status) $(message)"
      check "  ... which account 1 still has, as it set them" "l5-one 200" "$(notified_by as_user_1 l5-photos-1) $(status)"
      ;;
    "GET /buckets/{name}/website" | "PUT /buckets/{name}/website" | "DELETE /buckets/{name}/website")
      as_user_2 "$method" /buckets/l5-photos-1/website "$([ "$method" = PUT ] && echo '{"indexDocument": {"suffix": "stolen.html"}}' || true)" >/dev/null
      check "$route: account 2 gets 404 for account 1's bucket's site" '404 The account has no bucket named "l5-photos-1"' "$(status) $(message)"
      check "  ... which account 1 still has, as it set it" "index.html 200" "$(site_of as_user_1 l5-photos-1) $(status)"
      ;;
    "GET /buckets/{name}/website/domains" | "POST /buckets/{name}/website/domains" | "POST /buckets/{name}/website/domains/{domain}/verify" | "DELETE /buckets/{name}/website/domains/{domain}")
      path="${template//\{name\}/l5-photos-1}"
      as_user_2 "$method" "${path//\{domain\}/l5-one.example.tn}" "$(body_for "$method" "$template")" >/dev/null
      check "$route: account 2 gets 404 for account 1's bucket's site's domains" '404 The account has no bucket named "l5-photos-1"' "$(status) $(message)"
      check "  ... which account 1 still has" "l5-one.example.tn 200" "$(site_domains_of as_user_1 l5-photos-1) $(status)"
      ;;
    "POST /buckets/{name}/website/deploy-keys" | "DELETE /buckets/{name}/website/deploy-keys/{id}")
      path="${template//\{name\}/l5-photos-1}"
      as_user_2 "$method" "${path//\{id\}/AKFF0000000000000000}" >/dev/null
      check "$route: account 2 gets 404 for a deploy's key to account 1's bucket" '404 The account has no bucket named "l5-photos-1"' "$(status) $(message)"
      ;;
    "GET /buckets/{name}/metrics")
      as_user_2 GET /buckets/l5-photos-1/metrics >/dev/null
      check "$route: account 2 gets 404 for account 1's bucket's metrics" '404 The account has no bucket l5-photos-1' "$(status) $(message)"
      check "  ... which account 1 reads" "true 200" "$(as_user_1 GET /buckets/l5-photos-1/metrics | jq '.metrics.AllRequests.Sum | type == "array"') $(status)"
      ;;
    "GET /buckets/{name}/website/metrics")
      as_user_2 GET /buckets/l5-photos-1/website/metrics >/dev/null
      check "$route: account 2 gets 404 for account 1's site's metrics" '404 The account has no bucket l5-photos-1' "$(status) $(message)"
      check "  ... which account 1 reads" "true 200" "$(as_user_1 GET /buckets/l5-photos-1/website/metrics | jq '.metrics.Requests.Sum | type == "array"') $(status)"
      ;;
    "GET /queues")
      listed="$(as_user_2 GET /queues | jq 'map(select(.name == "l5-orders-1")) | length')"
      check "$route: account 2's list doesn't show account 1's queue" "200 0" "$(status) $listed"
      ;;
    "POST /queues")
      as_user_2 POST /queues '{"name": "l5-orders-2"}' >/dev/null
      check "$route: account 2 makes a queue of its own, which account 1's list doesn't show" "201 0" "$(status) $(as_user_1 GET /queues | jq 'map(select(.name == "l5-orders-2")) | length')"
      ;;
    "GET /queues/{name}" | "PATCH /queues/{name}" | "DELETE /queues/{name}" | "POST /queues/{name}/purge" | "POST /queues/{name}/messages" | "POST /queues/{name}/receive")
      as_user_2 "$method" "${template/\{name\}/l5-orders-1}" "$(queue_body "$route")" >/dev/null
      check "$route: account 2 gets 404 for account 1's queue" '404 The account has no queue named "l5-orders-1"' "$(status) $(message)"
      check "  ... which account 1 still has, its message still there and not received" "l5-orders-1 1 200" "$(kept_by as_user_1 l5-orders-1) $(status)"
      ;;
    "DELETE /queues/{name}/messages/{receiptHandle}")
      as_user_2 DELETE /queues/l5-orders-1/messages/bm90LWEtaGFuZGxl >/dev/null
      check "$route: account 2 gets 404 for account 1's queue's message" '404 The account has no queue named "l5-orders-1"' "$(status) $(message)"
      check "  ... whose message account 1 still has" "l5-orders-1 1 200" "$(kept_by as_user_1 l5-orders-1) $(status)"
      ;;
    "GET /queues/{name}/metrics")
      as_user_2 GET /queues/l5-orders-1/metrics >/dev/null
      check "$route: account 2 gets 404 for account 1's queue's metrics" '404 The account has no queue l5-orders-1' "$(status) $(message)"
      check "  ... which account 1 reads" "true 200" "$(as_user_1 GET /queues/l5-orders-1/metrics | jq '.metrics.NumberOfMessagesSent.Sum | type == "array"') $(status)"
      ;;
    "GET /event-sources")
      listed="$(as_user_2 GET /event-sources | jq --arg uuid "$mapping_1" 'map(select(.uuid == $uuid)) | length')"
      check "$route: account 2's list doesn't show account 1's function reading its queue" "200 0" "$(status) $listed"
      check "  ... nor does account 2 find one reading account 1's queue by its ARN" "0 200" \
        "$(as_user_2 GET "/event-sources?eventSourceArn=$(uri "arn:aws:sqs:tn-tunis-1:$account_1:l5-orders-1")" | jq length) $(status)"
      ;;
    "GET /event-sources/{uuid}" | "PATCH /event-sources/{uuid}" | "DELETE /event-sources/{uuid}")
      as_user_2 "$method" "/event-sources/$mapping_1" "$([ "$method" = PATCH ] && echo '{"enabled": true}' || true)" >/dev/null
      check "$route: account 2 gets 404 for account 1's mapping" "404 The account has no event source mapping $mapping_1" "$(status) $(message)"
      check "  ... which account 1 still has, disabled" "Disabled 10 200" "$(as_user_1 GET "/event-sources/$mapping_1" | jq -r '"\(.state) \(.batchSize)"') $(status)"
      ;;
    "GET /storage-keys")
      listed="$(as_user_2 GET /storage-keys | jq --arg id "$key_1_s3_id" 'map(select(.id == $id)) | length')"
      check "$route: account 2's list doesn't show account 1's key" "200 0" "$(status) $listed"
      ;;
    "POST /storage-keys")
      key_2_s3="$(as_user_2 POST /storage-keys '{}')"
      check "$route: user 2 makes account 2's own key, which account 1's list doesn't show" "201 0" \
        "$(status) $(as_user_1 GET /storage-keys | jq --arg id "$(jq -r .id <<<"$key_2_s3")" 'map(select(.id == $id)) | length')"
      ;;
    "DELETE /storage-keys/{id}")
      as_user_2 DELETE "/storage-keys/$key_1_s3_id" >/dev/null
      check "$route: account 2 can't revoke account 1's key: 404" "404 The account has no access key $key_1_s3_id" "$(status) $(message)"
      check "  ... which still opens account 1's bucket" accepted "$(s3_with "$key_1_s3_id" "$key_1_s3_secret" "$storage_port_oidc" s3 ls s3://l5-photos-1)"
      ;;
    "GET /databases")
      listed="$(as_user_2 GET /databases | jq --arg id "$db_1" 'map(select(.id == $id)) | length')"
      check "$route: account 2's list doesn't show account 1's database" "200 0" "$(status) $listed"
      ;;
    "POST /databases")
      db_2="$(as_user_2 POST /databases '{"name": "l5-one"}' | jq -r .id)"
      check "$route: user 2 makes account 2's own database" 201 "$(status)"
      check "  ... which account 1's list doesn't show" 0 "$(as_user_1 GET /databases | jq --arg id "$db_2" 'map(select(.id == $id)) | length')"
      ;;
    "GET /databases/{id}" | "DELETE /databases/{id}" | "POST /databases/{id}/password" | "GET /databases/{id}/metrics")
      as_user_2 "$method" "${template//\{id\}/$db_1}" >/dev/null
      check "$route: account 2 gets 404 for account 1's database" "404 Database $db_1 not found" "$(status) $(message)"
      database_now="$(as_user_1 GET "/databases/$db_1")"
      check "  ... which account 1 still has, its password unchanged" "200 active 1" "$(status) $(jq -r .status <<<"$database_now") $(data_db_psql "$conn_1" 'select 1')"
      ;;
    "GET /caches")
      listed="$(as_user_2 GET /caches | jq --argjson port "$cache_port_1" 'map(select(.port == $port)) | length')"
      check "$route: account 2's list doesn't show account 1's cache" "200 0" "$(status) $listed"
      ;;
    "POST /caches")
      cache_2="$(as_user_2 POST /caches '{"name": "l5-one"}')"
      check "$route: account 2 makes a cache of its own, of the name account 1's has" 201 "$(status)"
      check "  ... which account 1's list doesn't show" 0 "$(as_user_1 GET /caches | jq --argjson port "$(jq -r .port <<<"$cache_2")" 'map(select(.port == $port)) | length')"
      as_user_2 DELETE /caches/l5-one >/dev/null
      check "  ... and which account 2 deletes, account 1's own untouched" "204 one" "$(status) $(cache_cli "$cache_conn_1" GET l5)"
      ;;
    "GET /email/identities")
      listed="$(as_user_2 GET /email/identities | jq 'map(select(.dkimSelector == "'"$selector_1"'")) | length')"
      check "$route: account 2's list doesn't show account 1's domain" "200 0" "$(status) $listed"
      ;;
    "POST /email/identities")
      as_user_2 POST /email/identities '{"identity": "shop.l5.example.tn"}' >/dev/null
      check "$route: account 2 adds the domain account 1 has, with a DKIM key of its own: identities are each account's" "201 true" \
        "$(status) $([ "$(jq -r .dkimSelector "$work/body")" != "$selector_1" ] && echo true || echo false)"
      as_user_2 DELETE /email/identities/shop.l5.example.tn >/dev/null
      check "  ... and which account 2 deletes, account 1's own untouched" "204 $selector_1" "$(status) $(as_user_1 GET /email/identities/shop.l5.example.tn | jq -r .dkimSelector)"
      ;;
    "GET /email/identities/{identity}" | "POST /email/identities/{identity}/verify" | "DELETE /email/identities/{identity}")
      as_user_2 "$method" "${template//\{identity\}/shop.l5.example.tn}" >/dev/null
      check "$route: account 2 gets 404 for account 1's domain" "404 The account has no identity shop.l5.example.tn" "$(status) $(message)"
      kept="$(as_user_1 GET /email/identities/shop.l5.example.tn | jq -r .dkimSelector)"
      check "  ... which account 1 still has, its key unchanged" "200 $selector_1" "$(status) $kept"
      ;;
    "GET /email/account")
      sending="$(as_user_2 GET /email/account | jq -r .sentLast24Hours)"
      check "$route: account 2 reads its own sending, nothing of account 1's in it" "200 0" "$(status) $sending"
      ;;
    "GET /email/messages")
      listed="$(as_user_2 GET /email/messages | jq '.messages | length')"
      check "$route: account 2's messages don't show account 1's" "200 0" "$(status) $listed"
      ;;
    "GET /email/metrics")
      sent="$(as_user_2 GET /email/metrics | jq '[.metrics.Send.Sum[]] | add')"
      check "$route: account 2's mail's metrics count none of account 1's" "200 0" "$(status) $sent"
      ;;
    "POST /email/messages")
      as_user_2 POST /email/messages '{"from": "orders@shop.l5.example.tn", "to": ["team@shop.l5.example.tn"], "subject": "l5", "text": "account 2'"'"'s"}' >/dev/null
      check "$route: account 2 can't send from account 1's domain, which isn't its own" \
        "400 Email address is not verified. The following identities failed the check in region TN-TUNIS-1: orders@shop.l5.example.tn" "$(status) $(message)"
      check "  ... account 1's message still its alone" "$message_1 1" "$(as_user_1 GET /email/messages | jq -r '"\(.messages[0].messageId) \(.messages | length)"')"
      ;;
    "GET /email/suppressions")
      listed="$(as_user_2 GET /email/suppressions | jq '.suppressions | length')"
      check "$route: account 2's list doesn't show account 1's address" "200 0" "$(status) $listed"
      ;;
    "PUT /email/suppressions/{address}")
      as_user_2 PUT /email/suppressions/gone@l5.example.tn '{"reason": "COMPLAINT"}' >/dev/null
      check "$route: account 2 puts the address account 1 has on its own list, account 1's reason untouched" "200 BOUNCE" \
        "$(status) $(as_user_1 GET /email/suppressions | jq -r '.suppressions[] | select(.address == "gone@l5.example.tn") | .reason')"
      as_user_2 DELETE /email/suppressions/gone@l5.example.tn >/dev/null
      check "  ... and which account 2 takes off its list, account 1's still on account 1's" "204 1" "$(status) $(as_user_1 GET /email/suppressions | jq '.suppressions | length')"
      ;;
    "DELETE /email/suppressions/{address}")
      as_user_2 DELETE /email/suppressions/gone@l5.example.tn >/dev/null
      check "$route: account 2 gets 404 for account 1's address" "404 gone@l5.example.tn is not on the account's suppression list" "$(status) $(message)"
      check "  ... which account 1's list still has" 1 "$(as_user_1 GET /email/suppressions | jq '.suppressions | length')"
      ;;
    "GET /caches/{name}" | "DELETE /caches/{name}" | "POST /caches/{name}/password" | "GET /caches/{name}/metrics")
      as_user_2 "$method" "${template//\{name\}/l5-one}" >/dev/null
      check "$route: account 2 gets 404 for account 1's cache" "404 The account has no cache l5-one" "$(status) $(message)"
      cache_now="$(as_user_1 GET /caches/l5-one)"
      check "  ... which account 1 still has, its password unchanged" "200 active one" "$(status) $(jq -r .status <<<"$cache_now") $(cache_cli "$cache_conn_1" GET l5)"
      ;;
    "GET /alarms/{id}" | "PUT /alarms/{id}" | "DELETE /alarms/{id}")
      as_user_2 "$method" "/alarms/$alarm_1" "$([ "$method" = PUT ] && alarm_body || true)" >/dev/null
      check "$route: account 2 gets 404 for account 1's alarm" "404 Alarm $alarm_1 not found" "$(status) $(message)"
      alarm_now="$(as_user_1 GET "/alarms/$alarm_1")"
      check "  ... which account 1 still has, unchanged" "200 l5 Errors $fn_1" "$(status) $(jq -r '"\(.name) \(.metric) \(.functionId)"' <<<"$alarm_now")"
      ;;
    *'{'*)
      as_user_2 "$method" "$(path_for "$template" "$method" "$fn_1" "$account_1")" "$(body_for "$method" "$template")" >/dev/null
      check "$method $template: 404, as for a missing function" "404 Function with ID $fn_1 not found" "$(status) $(message)"
      ;;
    "GET /schedules/next-runs")
      runs_2="$(as_user_2 GET "$(path_for "$template" "$method" "$fn_1" "$account_1")")"
      check "$route: user 2 previews an expression, which reads no account's data" "200 5" "$(status) $(jq '.runs | length' <<<"$runs_2")"
      ;;
    "GET /notifications/webhook-secret")
      secret_2="$(as_user_2 GET /notifications/webhook-secret | jq -r .secret)"
      check "$route: account 2 reads its own signing secret, not account 1's" "200 true" \
        "$(status) $([ "$secret_2" != "$(as_user_1 GET /notifications/webhook-secret | jq -r .secret)" ] && echo true || echo false)"
      ;;
    "POST /notifications/webhook-secret/rotate")
      secret_1_before="$(as_user_1 GET /notifications/webhook-secret | jq -r .secret)"
      as_user_2 POST /notifications/webhook-secret/rotate >/dev/null
      check "$route: account 2 rotates its own secret, never account 1's" "200 $secret_1_before" "$(status) $(as_user_1 GET /notifications/webhook-secret | jq -r .secret)"
      ;;
    "POST /notifications/test")
      test_2="$(as_user_2 POST /notifications/test "$(body_for POST /notifications/test)" | jq -r .notificationId)"
      check "$route: account 2 tests its own webhook" 202 "$(status)"
      check "  ... which account 1's deliveries don't show" 0 "$(as_user_1 GET /notifications/deliveries | jq --arg id "$test_2" 'map(select(.notificationId == $id)) | length')"
      ;;
    "GET /notifications/deliveries")
      others="$(as_user_2 GET /notifications/deliveries | jq --arg url "$receiver/b" 'map(select(.target != $url)) | length')"
      check "$route: account 2 lists only its own deliveries" "200 0" "$(status) $others"
      ;;
    "GET /alarms")
      listed="$(as_user_2 GET /alarms | jq --arg id "$alarm_1" 'map(select(.id == $id)) | length')"
      check "$route: account 2's list doesn't show account 1's alarm" "200 0" "$(status) $listed"
      ;;
    "POST /alarms")
      as_user_2 POST /alarms "$(alarm_body "$fn_1")" >/dev/null
      check "$route: account 2 can't watch account 1's function" "404 Function with ID $fn_1 not found" "$(status) $(message)"
      as_user_2 POST /alarms '{"name": "l5", "bucketName": "l5-photos-1", "metric": "5xxErrors", "statistic": "Sum", "period": 60, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' >/dev/null
      check "  ... nor account 1's bucket" "404 The account has no bucket l5-photos-1" "$(status) $(message)"
      as_user_2 POST /alarms '{"name": "l5", "queueName": "l5-orders-1", "metric": "ApproximateNumberOfMessagesVisible", "statistic": "Maximum", "period": 60, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' >/dev/null
      check "  ... nor account 1's queue" "404 The account has no queue l5-orders-1" "$(status) $(message)"
      as_user_2 POST /alarms '{"name": "l5", "cacheName": "l5-one", "metric": "BytesUsedForCache", "statistic": "Maximum", "period": 3600, "comparison": "GreaterThanThreshold", "threshold": 0, "evaluationPeriods": 1, "datapointsToAlarm": 1, "actions": {"email": false, "webhookUrls": []}}' >/dev/null
      check "  ... nor account 1's cache" "404 The account has no cache l5-one" "$(status) $(message)"
      ;;
    "POST /packages")
      upload_package "$api_oidc" "$work/package-b.zip" -H "Authorization: Bearer $token_2" -H "X-FF-Account: ${account_2:-}" >/dev/null
      check "$route: account 2's member uploads a package of account 2's" 201 "$(status)"
      check "  ... which account 1's list doesn't show" 0 "$(as_user_1 GET /packages | jq --arg sha "$package_b" 'map(select(.codeSha256 == $sha)) | length')"
      as_user_2 POST /functions "$(jq -n --arg sha "$package_1" '{name: "l5-not-mine", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 128, timeout: 5}')" >/dev/null
      check "  ... and account 2 can't name account 1's package in a function" \
        "400 The account has no package $package_1: upload it with POST /packages, which answers its SHA-256" "$(status) $(messages)"
      ;;
    "GET /packages")
      listed="$(as_user_2 GET /packages | jq --arg sha "$package_1" 'map(select(.codeSha256 == $sha)) | length')"
      check "$route: account 2's list doesn't show account 1's package, nor finds it by its SHA-256" "200 0 0" \
        "$(status) $listed $(as_user_2 GET "/packages?codeSha256=$(uri "$package_1")" | jq length)"
      ;;
    *) fail "$route: the L5 suite has no rule for this route" ;;
  esac
done
for type in Event DryRun; do
  with_token "$token_2" POST "/functions/$fn_1/invoke" '{"input": {"name": "two"}}' -H "X-FF-Account: ${account_2:-}" -H "X-Amz-Invocation-Type: $type" >/dev/null
  check "POST /functions/{id}/invoke as $type: account 2's call of account 1's function answers as for a missing function" "404 Function with ID $fn_1 not found" "$(status) $(message)"
done
check "  ... and nothing of account 2's waits in account 1's function's queue" 0 "$(waiting_for "$fn_1")"
as_user_2 PUT "/functions/$own/event-invoke-config" "$(jq -cn --arg arn "arn:aws:lambda:tn-tunis-1:$account_1:function:l5-one" '{destinationConfig: {onSuccess: {destination: $arn}}}')" >/dev/null
check "account 2 can't name account 1's function as the destination of its own function's calls" \
  "400 destinationConfig.onSuccess.destination must be a function of this account, in tn-tunis-1: arn:aws:lambda:tn-tunis-1:$account_2:function:l5-one" "$(status) $(message)"
check "account 1's function, history and limits are unchanged" "$before_1" "$(snapshot as_user_1 "$fn_1")"
check "and so is its name" "$name_1" "$(as_user_1 GET "/accounts/$account_1" | jq -r .name)"
check "and so are its members and invitations" "$members_1" \
  "$(as_user_1 GET /members | jq -c '{members: [.members[].email], invitations: [.invitations[].email]}')"
with_token "$token_2" GET /functions '' -H "X-FF-Account: $account_1" >/dev/null
check "naming account 1 in X-FF-Account: 404" "404 Account $account_1 not found" "$(status) $(message)"
with_token "$token_2" GET /functions >/dev/null
check "user 2, now in two accounts, must name one" \
  "400 This user belongs to several accounts: name one in the X-FF-Account header" "$(status) $(message)"
}
section_def isolation section_isolation signup s3_keys budget=25

section_api_keys() {
section "API keys"
listed="$(with_token "$key_1" GET /functions | jq --arg id "$fn_1" 'map(select(.id == $id)) | length')"
check "account 1's key lists its account's functions" "200 1" "$(status) $listed"
with_token "$key_1" POST "/functions/$fn_1/invoke" '{"input":{"name":"key"}}' >/dev/null
check "and invokes them" 201 "$(status)"
with_token "$key_1" PUT "/functions/$fn_1" '{"name": "renamed"}' >/dev/null
check "but can't change one without functions:write" "403 This API key lacks the scope functions:write" "$(status) $(message)"
with_token "$key_1" GET /usage >/dev/null
check "nor read usage without usage:read (P-22)" "403 This API key lacks the scope usage:read" "$(status) $(message)"
with_token "$key_1" GET /billing/balance >/dev/null
check "nor the balance (P-32)" "403 This API key lacks the scope usage:read" "$(status) $(message)"
key_usage="$(as_user_2 POST /api-keys '{"name": "l5 usage", "scopes": ["usage:read"]}' | jq -r .key)"
check "account 2 makes a key with usage:read only" 201 "$(status)"
usage_key="$(with_token "$key_usage" GET /usage)"
check "which reads its own account's usage, never account 1's" "200 0" \
  "$(status) $(jq --arg id "$fn_1" '[.functions[] | select(.functionId == $id)] | length' <<<"$usage_key")"
balance_key="$(with_token "$key_usage" GET /billing/balance)"
check "and its own account's balance, without account 1's credit (P-32)" "200 0.000" "$(status) $(jq -r .balance <<<"$balance_key")"
alerts_key="$(with_token "$key_usage" GET /billing/alerts)"
check "and its low-balance shares (P-33)" "200 [90]" "$(status) $(jq -c .lowBalancePercents <<<"$alerts_key")"
pro_formas_key="$(with_token "$key_usage" GET /billing/pro-formas)"
check "and its own account's pro-formas, none of account 1's (P-35)" "200 $pf_2" "$(status) $(jq -r '[.proFormas[].id] | join(" ")' <<<"$pro_formas_key")"
with_token "$key_usage" POST /billing/pro-formas '{"credit": "20"}' >/dev/null
check "but can't ask for one: that takes an owner's token" "403 API keys can't call this route: it takes a user's token" "$(status) $(message)"
with_token "$key_usage" POST "/billing/pro-formas/$pf_2/cancel" >/dev/null
check "nor cancel one (P-74)" "403 API keys can't call this route: it takes a user's token" "$(status) $(message)"
invoices_key="$(with_token "$key_usage" GET /billing/invoices)"
check "and lists its own account's invoices (P-36)" "200 0" "$(status) $(jq '.invoices | length' <<<"$invoices_key")"
check "and downloads its usage statements" "200 application/pdf" "$(fetch_pdf "$api_oidc" "/billing/statements/$(date -u +%Y-%m)/pdf" -H "Authorization: Bearer $key_usage")"
with_token "$key_1" GET /billing/invoices >/dev/null
check "a key without usage:read can't list invoices" "403 This API key lacks the scope usage:read" "$(status) $(message)"
with_token "$key_1" GET "/functions/$fn_1/logs" >/dev/null
check "a key without logs:read can't read a function's logs (P-40)" "403 This API key lacks the scope logs:read" "$(status) $(message)"
with_token "$key_1" GET /billing/pro-formas >/dev/null
check "a key without usage:read can't list them" "403 This API key lacks the scope usage:read" "$(status) $(message)"
with_token "$key_1" GET /databases >/dev/null
check "a key without databases:read can't list the account's databases" "403 This API key lacks the scope databases:read" "$(status) $(message)"
with_token "$key_1" POST /databases '{"name": "by-key"}' >/dev/null
check "nor make one without databases:write" "403 This API key lacks the scope databases:write" "$(status) $(message)"
with_token "$key_1" GET /caches >/dev/null
check "a key without caches:read can't list the account's caches" "403 This API key lacks the scope caches:read" "$(status) $(message)"
with_token "$key_1" POST /caches '{"name": "by-key"}' >/dev/null
check "nor make one without caches:write" "403 This API key lacks the scope caches:write" "$(status) $(message)"
with_token "$key_1" GET /email/identities >/dev/null
check "a key without email:read can't list the domains and addresses the account sends mail from" "403 This API key lacks the scope email:read" "$(status) $(message)"
with_token "$key_1" POST /email/identities '{"identity": "by-key.l5.example.tn"}' >/dev/null
check "nor add one without email:write" "403 This API key lacks the scope email:write" "$(status) $(message)"
with_token "$key_1" GET /buckets >/dev/null
check "a key without storage:read can't list the account's buckets" "403 This API key lacks the scope storage:read" "$(status) $(message)"
with_token "$key_1" POST /buckets '{"name": "l5-by-key"}' >/dev/null
check "nor make one without storage:write" "403 This API key lacks the scope storage:write" "$(status) $(message)"
with_token "$key_1" GET /queues >/dev/null
check "a key without queues:read can't list the account's queues" "403 This API key lacks the scope queues:read" "$(status) $(message)"
with_token "$key_1" POST /queues/l5-orders-1/messages '{"body": "by key"}' >/dev/null
check "nor send to one without queues:write" "403 This API key lacks the scope queues:write" "$(status) $(message)"
with_token "$key_usage" PUT /billing/alerts '{"lowBalancePercents": [10]}' >/dev/null
check "but can't change them: that takes an owner's token" "403 API keys can't call this route: it takes a user's token" "$(status) $(message)"
me_key="$(with_token "$key_1" GET /me)"
check "a key reads GET /me whatever its scopes: itself, and only its own account, with its creator's role" \
  "200 $key_1_id l5 reader functions:read,functions:invoke $account_1 owner 1 true" \
  "$(status) $(jq -r '[.key.id, .key.name, (.key.scopes | join(",")), .accounts[0].id, .accounts[0].role, (.accounts | length), (.user == null)] | join(" ")' <<<"$me_key")"
for path in /api-keys /members /audit-log; do
  with_token "$key_1" GET "$path" >/dev/null
  check "a key can't call GET $path, which takes a user's token" \
    "403 API keys can't call this route: it takes a user's token" "$(status) $(message)"
done
for route in "${routes[@]}"; do
  case $route in *" /admin/"*) ;; *) continue ;; esac
  with_token "$key_1" "${route%% *}" "${route#* }" "$(body_for "${route%% *}" "${route#* }")" >/dev/null
  check "a key can't call $route (P-70)" "403 API keys can't call the admin routes" "$(status) $(message)"
done
for route in "${routes[@]}"; do
  method="${route%% *}"
  template="${route#* }"
  case $template in /functions/*) ;; *) continue ;; esac
  with_token "$key_2" "$method" "$(path_for "$template" "$method" "$fn_1" "$account_1")" "$(body_for "$method" "$template")" >/dev/null
  check "account 2's key on $route: 404" "404 Function with ID $fn_1 not found" "$(status) $(message)"
done
}
section_def api_keys section_api_keys isolation budget=10

section_url_credentials() {
section "a function URL that takes the account's credentials"
url_1="$(as_user_1 POST "/functions/$fn_1/url" '{"authType": "AWS_IAM"}' | jq -r .functionUrl)"
check "account 1 gives its function a URL that takes its account's API keys" "201 AWS_IAM" "$(status) $(as_user_1 GET "/functions/$fn_1/url" | jq -r .authType)"
check "account 1's key with functions:invoke calls it" '200 {"message":"Hello world"}' "$(call_url "$url_1" -H "Authorization: Bearer $key_1") $(cat "$work/url-body")"
check "account 2's key, which may invoke account 2's functions, can't" '403 {"Message":"Forbidden"}' \
  "$(call_url "$url_1" -H "Authorization: Bearer $key_2") $(cat "$work/url-body")"
check "nor a key without functions:invoke, nor a user's token, nor nobody" "403 403 403" \
  "$(call_url "$url_1" -H "Authorization: Bearer $key_usage") $(call_url "$url_1" -H "Authorization: Bearer $token_1") $(call_url "$url_1")"
check "the call is in account 1's history as its URL's, and account 2's key reaches none of it" "url 404" \
  "$(as_user_1 GET "/functions/$fn_1/invocations?limit=1" | jq -r '.invocations[0].source') $(with_token "$key_2" GET "/functions/$fn_1/url" >/dev/null; status)"
as_user_1 DELETE "/api-keys/$key_1_id" >/dev/null
check "account 1 revokes its key" 200 "$(status)"
with_token "$key_1" GET /functions >/dev/null
check "which stops working at once" "401 The API key was revoked" "$(status) $(message)"
check "on the URL too" 403 "$(call_url "$url_1" -H "Authorization: Bearer $key_1")"
as_user_1 DELETE "/functions/$fn_1/url" >/dev/null
check "account 1 deletes the URL" 204 "$(status)"
check "account 1's function was invoked twice more by its key, through the API and its URL, and is otherwise unchanged" \
  "$(jq -c '.invocations += 2' <<<"$before_1")" "$(snapshot as_user_1 "$fn_1")"
}
section_def url_credentials section_url_credentials api_keys budget=5

section_members() {
section "members (P-16): user 2 is invited into account 1"
as_user_1 POST /members "$(jq -cn --arg email "$user_2" '{email: $email, role: "viewer"}')" >/dev/null
check "account 1's owner invites user 2's address as a viewer" 201 "$(status)"
check "user 2 gets an e-mail with the console's address" true \
  "$(mail_to "$user_2" | grep 'http://localhost:5199' >/dev/null && echo true || echo false)"
check "in user 2's language, French, though user 1's is English" "$user_1 vous invite sur le compte FF « L5 one »" "$(mail_to "$user_2" | head -1)"
check "user 2 joins on the next call: account 1 is in GET /me, as a viewer" "viewer" \
  "$(with_token "$token_2" GET /me | jq -r --arg id "$account_1" '.accounts[] | select(.id == $id) | .role')"
as_member() { with_token "$token_2" "$1" "$2" "${3:-}" -H "X-FF-Account: $account_1"; }
listed="$(as_member GET /functions | jq --arg id "$fn_1" 'map(select(.id == $id)) | length')"
check "as a viewer, user 2 reads account 1's functions" "200 1" "$(status) $listed"
usage_1="$(as_member GET /usage)"
check "and its usage (P-22)" "200 true" \
  "$(status) $(jq --arg id "$fn_1" '[.functions[] | select(.functionId == $id) | .requests > 0] | any' <<<"$usage_1")"
as_member POST "/functions/$fn_1/invoke" '{"input":{}}' >/dev/null
check "but can't invoke them" "403 The viewer role can't do this" "$(status) $(message)"
as_member PUT /billing/alerts '{"lowBalancePercents": [10]}' >/dev/null
check "nor set the low-balance e-mails (P-33)" "403 The viewer role can't do this" "$(status) $(message)"
as_member GET /billing/invoices >/dev/null
check "a viewer reads account 1's invoices (P-36)" 200 "$(status)"
as_member GET "/functions/$fn_1/logs?tail=5" >/dev/null
check "and its function's logs (P-40)" 200 "$(status)"
listed_pro_formas="$(as_member GET /billing/pro-formas | jq -r '[.proFormas[].id] | join(" ")')"
check "but reads account 1's pro-formas (P-35)" "200 $pf_1" "$(status) $listed_pro_formas"
as_member POST /billing/pro-formas '{"credit": "20"}' >/dev/null
check "and can't ask for one (P-35)" "403 The viewer role can't do this" "$(status) $(message)"
as_member POST "/billing/pro-formas/$pf_1/cancel" >/dev/null
check "nor cancel one (P-74)" "403 The viewer role can't do this" "$(status) $(message)"
user_2_id="$(with_token "$token_2" GET /me | jq -r .user.id)"
as_user_1 PATCH "/members/$user_2_id" '{"role": "developer"}' >/dev/null
check "the owner makes user 2 a developer" 200 "$(status)"
as_member POST "/functions/$fn_1/invoke" '{"input":{}}' >/dev/null
check "who now invokes" 201 "$(status)"
as_member GET /members >/dev/null
check "but doesn't manage members" "403 The developer role can't do this" "$(status) $(message)"
as_member PUT /billing/alerts '{"lowBalancePercents": [10]}' >/dev/null
check "nor the low-balance e-mails, which are the owners' (P-33)" "403 The developer role can't do this" "$(status) $(message)"
as_member POST /billing/pro-formas '{"credit": "20"}' >/dev/null
check "nor ask for a pro-forma, the owners' too (P-35)" "403 The developer role can't do this" "$(status) $(message)"
as_member POST "/billing/pro-formas/$pf_1/cancel" >/dev/null
check "nor cancel one (P-74)" "403 The developer role can't do this" "$(status) $(message)"
as_user_1 DELETE "/members/$user_1_id" >/dev/null
check "the last owner can't leave" "400 An account needs an owner: make another member owner first" "$(status) $(message)"
as_user_1 DELETE "/members/$user_2_id" >/dev/null
check "the owner removes user 2" 200 "$(status)"
as_member GET /functions >/dev/null
check "who can't reach account 1 any more" "404 Account $account_1 not found" "$(status) $(message)"
}
section_def members section_members isolation budget=5

section_audit() {
section "the audit log (P-17)"
log_1="$(as_user_1 GET '/audit-log?limit=100')"
check "account 1's log has each change, oldest to newest, FF's approval included (P-71)" \
  "account.create account.approve function.create api_key.create member.invite billing.pro_forma alarm.create package.upload database.create cache.create email.identity.create email.suppression.put bucket.create queue.create event_source.create queue.create bucket.notifications bucket.website custom_domain.add storage_key.create function_url.create api_key.revoke function_url.delete member.invite member.join member.role member.remove" \
  "$(jq -r '[.entries[].action] | reverse | join(" ")' <<<"$log_1")"
check "each names who did it: user 1, or user 2 who joined" "$user_1 $user_2" \
  "$(jq -r '[(.entries[] | select(.action == "member.role")), (.entries[] | select(.action == "member.join"))] | map(.actorLabel) | join(" ")' <<<"$log_1")"
check "with the address and the request's ID" true \
  "$(jq '[.entries[] | select(.actor != "operator") | (.ip != null and (.requestId | test("^[0-9a-f-]{36}$")))] | all' <<<"$log_1")"
check "the approval is FF's, with the operator's reason, but neither their e-mail nor their address" "operator FF null l5: use case checked" \
  "$(jq -r '.entries[] | select(.action == "account.approve") | "\(.actor) \(.actorLabel) \(.ip) \(.details.reason)"' <<<"$log_1")"
as_user_1 GET '/audit-log?limit=0' >/dev/null
check "a page of nothing is refused" "400 limit must not be less than 1" "$(status) $(jq -r '.message | join("; ")' "$work/body")"
}
section_def audit section_audit members budget=5

section_admin() {
section "the admin routes (P-70): FF's operator"
operator_token="$(keycloak_token ff-admin "$operator_email" "$operator_password")"
settings="$(with_token "$operator_token" GET /admin/settings)"
check "the operator reads the settings, through the admin dashboard's client" "200 true 24" \
  "$(status) $(jq -r '"\(.settings.billingShadowMode) \(.settings.gracePeriodHours)"' <<<"$settings")"
with_token "$operator_token" PUT /admin/settings '{"settings": {"gracePeriodHours": 48}}' >/dev/null
check "a change without a reason is refused" \
  "400 Every admin change needs a reason: send reason, 3 to 500 characters, in the body" "$(status) $(message)"
changed="$(with_token "$operator_token" PUT /admin/settings '{"settings": {"gracePeriodHours": 48}, "reason": "l5: pilot customers asked"}')"
check "with a reason, it is made" "200 48" "$(status) $(jq -r .settings.gracePeriodHours <<<"$changed")"
check "and the audit log keeps who, why, and what it replaced" "operator@ff.test|l5: pilot customers asked|24|48" \
  "$(sql_value "SELECT actor_label, details->>'reason', details->'changes'->'gracePeriodHours'->>'from', details->'changes'->'gracePeriodHours'->>'to'
       FROM audit_log WHERE action = 'settings.update' AND actor LIKE 'operator:%'" -F '|')"
}
section_def admin section_admin backends budget=5

section_operator_accounts() {
section "the operator's accounts (P-71)"
found="$(with_token "$operator_token" GET "/admin/accounts?q=$user_1")"
check "the operator finds account 1 by its owner's e-mail" "200 $account_1" "$(status) $(jq -r '[.accounts[].id] | join(" ")' <<<"$found")"
page_1="$(with_token "$operator_token" GET "/admin/accounts/$account_1")"
check "its page: the owner, the function and its last call, this month's usage, and how it became active" \
  "200 $user_1 l5-one true true pending,active" \
  "$(status) $(jq -r '"\(.members[0].email) \(.functions[0].name) \(.functions[0].lastInvokedAt != null) \(.usage.totals.requests > 0) \([.statusHistory[].status] | join(","))"' <<<"$page_1")"
# 7.000 TND for account 2, which account 1's 5.000 must not join (P-31).
grant "$account_2" 7000 "promo:l5-2"
page_balance_1="$(with_token "$operator_token" GET "/admin/accounts/$account_1")"
check "account 1's page has its own balance, 5.000 TND (P-31)" '200 [{"currency":"TND","balance":"5.000"}]' "$(status) $(jq -c .balances <<<"$page_balance_1")"
page_balance_2="$(with_token "$operator_token" GET "/admin/accounts/$account_2")"
check "and account 2's page its own, 7.000 TND, as a string to the millime" '200 [{"currency":"TND","balance":"7.000"}]' "$(status) $(jq -c .balances <<<"$page_balance_2")"
# 3.000 TND of usage on account 1's 5.000: 40% left, past 50% of the last credit (P-33).
sql "
  INSERT INTO ledger_accounts (type, currency) VALUES ('revenue', 'TND') ON CONFLICT DO NOTHING;
  WITH t AS (INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('usage', 'usage:l5-1') RETURNING id)
  INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor)
  SELECT t.id, a.id, CASE a.type WHEN 'wallet' THEN -3000 ELSE 3000 END FROM t, ledger_accounts a
   WHERE a.currency = 'TND' AND (a.account_id = '$account_1' OR (a.account_id IS NULL AND a.type = 'revenue'));"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^Your FF credit' >/dev/null && break; sleep 0.5; done
check "account 1's owner gets the low-balance e-mail, through the ledger's NOTIFY (P-33)" \
  "Your FF credit is down to 50%: $(as_user_1 GET "/accounts/$account_1" | jq -r .name)|2.000 TND" \
  "$(mail_to "$user_1" | head -1)|$(mail_to "$user_1" | sed -n 2p | grep -o '[0-9.]* TND' | head -1)"
with_token "$operator_token" POST "/admin/accounts/$account_1/suspend" '{"reason": "l5: abuse report"}' >/dev/null
check "the operator suspends account 1" 200 "$(status)"
check "its function is scaled to zero at once" 0 \
  "$(kubectl -n "$(tenant_namespace "$account_1")" get deployment "fn-$fn_1" -o jsonpath='{.spec.replicas}')"
check "its cache's user can't log in, the cache suspended with it (ADR 0013)" "true suspended" \
  "$(cache_cli "$cache_conn_1" GET l5 | grep WRONGPASS >/dev/null && echo true || echo false) $(as_user_1 GET /caches/l5-one | jq -r .status)"
as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"name":"one"}}' >/dev/null
check "its owner can't invoke" "403 Your account is suspended" "$(status) $(message)"
as_user_1 POST /functions "$(function_body l5-suspended)" >/dev/null
check "nor deploy" "403 Your account is suspended" "$(status) $(message)"
as_user_1 GET "/functions/$fn_1" >/dev/null
check "but still reads its functions" 200 "$(status)"
check "the owner gets an e-mail that says why" "Your FF account is suspended: L5 one true" \
  "$(mail_to "$user_1" | head -1) $(mail_to "$user_1" | grep '^Why: l5: abuse report$' >/dev/null && echo true || echo false)"
log_1="$(as_user_1 GET '/audit-log?limit=1')"
check "and sees it in the account's audit log as FF's, with the reason, without the operator's address" "account.suspend operator FF null l5: abuse report" \
  "$(jq -r '.entries[0] | "\(.action) \(.actor) \(.actorLabel) \(.ip) \(.details.reason)"' <<<"$log_1")"
with_token "$operator_token" POST "/admin/accounts/$account_1/approve" '{"reason": "l5 tries"}' >/dev/null
check "a change that doesn't apply is refused" "409 Account $account_1 is suspended: only a pending account can be approved" "$(status) $(message)"
with_token "$operator_token" POST "/admin/accounts/$account_1/reactivate" '{"reason": "l5: the owner fixed it"}' >/dev/null
check "the operator reactivates it" 200 "$(status)"
as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"name":"again"}}' >/dev/null
check "and its function answers again, from a cold start" 201 "$(status)"
check "and its cache lets its user in again, its keys kept" "one active" "$(cache_cli "$cache_conn_1" GET l5) $(as_user_1 GET /caches/l5-one | jq -r .status)"
}
section_def operator_accounts section_operator_accounts admin isolation budget=15

section_logs() {
section "the function's logs (P-40; from the log store, P-43)"
logged="$(as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"name":"logs"}}')"
logged_id="$(jq -r .id <<<"$logged")"
# The collector reads the container's log file and writes to the store within a few seconds.
for _ in $(seq 1 40); do
  logs_1="$(as_user_1 GET "/functions/$fn_1/logs")"
  [ "$(jq --arg id "$logged_id" '[.lines[] | select(.requestId == $id)] | length' <<<"$logs_1")" -ge 3 ] && break
  sleep 0.5
done
check "the owner reads the call's START, END and REPORT lines, each with its request ID" "200 START,END,REPORT" \
  "$(status) $(jq -r --arg id "$logged_id" '[.lines[] | select(.requestId == $id) | .message | capture("^(?<kind>START|END|REPORT) RequestId: (?<id>\\S+)") | select(.id == $id) | .kind] | join(",")' <<<"$logs_1")"
check "each line with its time to the nanosecond and its instance, oldest first, and no next page under 200 lines" "true true true null" \
  "$(jq '[.lines[].time | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}\\.[0-9]{9}Z$")] | all' <<<"$logs_1") $(jq --arg fn "fn-$fn_1" '[.lines[].instance | startswith($fn)] | all' <<<"$logs_1") $(jq '[.lines[].time] | . == sort' <<<"$logs_1") $(jq -c .next <<<"$logs_1")"
newest="$(as_user_1 GET "/functions/$fn_1/logs?tail=1")"
check "tail=1 gives the newest line alone" "200 1 $(jq -r '.lines[-1].message' <<<"$logs_1")" "$(status) $(jq '.lines | length' <<<"$newest") $(jq -r '.lines[0].message' <<<"$newest")"
recent="$(as_user_1 GET "/functions/$fn_1/logs?sinceSeconds=3600")"
check "sinceSeconds keeps the last hour's, the call among them" "200 true" "$(status) $(jq --arg id "$logged_id" '[.lines[] | select(.requestId == $id)] | length >= 3' <<<"$recent")"
as_user_1 GET "/functions/$fn_1/logs?tail=1001" >/dev/null
check "more than 1,000 lines is refused" "400 tail must not be greater than 1000" "$(status) $(jq -r '.message | join("; ")' "$work/body")"
call_lines="$(as_user_1 GET "/functions/$fn_1/logs?requestId=$logged_id")"
check "requestId gives that call's lines alone, with their streams (P-43)" "200 true true" \
  "$(status) $(jq --arg id "$logged_id" '(.lines | length >= 3) and ([.lines[].requestId == $id] | all)' <<<"$call_lines") $(jq '[.lines[].stream == "stdout"] | all' <<<"$call_lines")"
by_phrase="$(as_user_1 GET "/functions/$fn_1/logs?q=$logged_id")"
check "q finds the lines with the phrase: the call's START, END and REPORT" "200 START,END,REPORT" \
  "$(status) $(jq -r '[.lines[].message | capture("^(?<kind>START|END|REPORT) ").kind] | join(",")' <<<"$by_phrase")"
first_page="$(as_user_1 GET "/functions/$fn_1/logs?requestId=$logged_id&limit=1")"
first_next="$(jq -r .next <<<"$first_page")"
second_page="$(as_user_1 GET "/functions/$fn_1/logs?requestId=$logged_id&limit=1&cursor=$first_next")"
check "a page of 1 has a next, which gives the line before it" "200 1 true" \
  "$(status) $(jq '.lines | length' <<<"$second_page") $(jq -n --argjson a "$first_page" --argjson b "$second_page" '$b.lines[0].time <= $a.lines[0].time and $b.lines[0] != $a.lines[0]')"
as_user_1 GET "/functions/$fn_1/logs?start=2026-01-01T00:00:00Z&end=2026-01-02T00:00:00Z" >/dev/null
check "a window older than the plan's retention has no lines" "200 0 null" "$(status) $(jq '.lines | length' "$work/body") $(jq -c .next "$work/body")"
as_user_1 GET "/functions/$fn_1/logs?start=2026-10-17T11:00:00Z&end=2026-10-17T10:00:00Z" >/dev/null
check "a start after the end is refused" "400 start must be before end" "$(status) $(message)"
as_user_1 GET "/functions/$fn_1/logs?cursor=bm9wZQ" >/dev/null
check "a cursor no page gave is refused" "400 Invalid cursor: pass the next value of the page before" "$(status) $(message)"
# The live tail, open before a call: the call's lines come through it, about 5 s after they were written.
stream_file="$work/stream.txt"
curl -sN --max-time 60 -H "Authorization: Bearer $token_1" -D "$work/stream-headers" "$api_oidc/functions/$fn_1/logs/stream" >"$stream_file" 2>/dev/null &
stream_pid=$!
sleep 1
streamed_id="$(as_user_1 POST "/functions/$fn_1/invoke" '{"input":{"name":"live"}}' | jq -r .id)"
for _ in $(seq 1 60); do
  grep -q "\"requestId\":\"$streamed_id\".*REPORT RequestId" "$stream_file" 2>/dev/null && break
  sleep 0.5
done
# curl ends with the signal's status, which set -e must not take for a failure.
kill "$stream_pid" 2>/dev/null || true
wait "$stream_pid" 2>/dev/null || true
check "the live tail streams a call's START, END and REPORT as events, as they come (P-43)" "text/event-stream START,END,REPORT" \
  "$(grep -i '^content-type:' "$work/stream-headers" | tr -d '\r' | awk '{ print $2 }') $(grep '^data: {' "$stream_file" | sed 's/^data: //' | jq -r --arg id "$streamed_id" 'select(.requestId == $id) | .message | capture("^(?<kind>START|END|REPORT) ").kind' | paste -sd, -)"
key_logs="$(as_user_1 POST /api-keys '{"name": "l5 logs", "scopes": ["logs:read"]}' | jq -r .key)"
by_key="$(with_token "$key_logs" GET "/functions/$fn_1/logs?tail=5")"
check "a key with logs:read reads them" "200 5" "$(status) $(jq '.lines | length' <<<"$by_key")"
with_token "$key_logs" GET "/functions/$fn_1" >/dev/null
check "and only them" "403 This API key lacks the scope functions:read" "$(status) $(message)"
beta_limits="$(with_token "$operator_token" GET /admin/plans | jq -c '.[] | select(.id == "beta") | .limits')"
with_token "$operator_token" POST /admin/plans \
  "$(jq -cn --argjson limits "$beta_limits" '{id: "l5-large", name: "L5 large", limits: ($limits | .quota = {pods: 30, cpu: "12", memory: "12Gi"}), reason: "l5: a plan with room"}')" >/dev/null
check "the operator creates a plan with more room (P-73)" 201 "$(status)"
moved="$(with_token "$operator_token" PUT "/admin/accounts/$account_1/plan" '{"planId": "l5-large", "reason": "l5: needs more room"}')"
check "the operator moves account 1 to a larger plan, and its quota follows at once" "200 l5-large 30 12 12Gi" \
  "$(status) $(jq -r .account.planId <<<"$moved") $(kubectl -n "$(tenant_namespace "$account_1")" get resourcequota ff-tenant-quota -o jsonpath='{.spec.hard.pods} {.spec.hard.limits\.cpu} {.spec.hard.limits\.memory}')"
with_token "$operator_token" PUT "/admin/accounts/$account_1/plan" '{"planId": "imaginary", "reason": "l5 tries"}' >/dev/null
check "a plan that doesn't exist is refused" "404 Plan imaginary not found" "$(status) $(message)"
# Where an account's NetworkPolicy lets its functions go beyond DNS and FF's services, on any port: an address range,
# and how many ranges it keeps out (FF's own network, the cloud's metadata addresses); "none" when nowhere.
internet_rule() { # <account>
  kubectl -n "$(tenant_namespace "$1")" get networkpolicy ff-default-deny -o json |
    jq -r '[.spec.egress[] | select(any(.to[]?; .ipBlock.cidr == "0.0.0.0/0")) |
      "\(.to[0].ipBlock.cidr) except \(.to[0].ipBlock.except | length) on \([.ports[] | "\(.protocol) \(.port)-\(.endPort)"] | join(", "))"] |
      if length == 0 then "none" else join(",") end'
}
# FF's services the account's functions reach whatever its internet access, each address and its port, or its ports.
service_rules() { # <account>
  kubectl -n "$(tenant_namespace "$1")" get networkpolicy ff-default-deny -o json |
    jq -r '[.spec.egress[] | select(.ports != null and (.to | any(.ipBlock != null)) and all(.to[]; .ipBlock.cidr != "0.0.0.0/0")) |
      "\(.to[].ipBlock.cidr):\(.ports[0].port)\(if .ports[0].endPort then "-\(.ports[0].endPort)" else "" end)"] | join(",")'
}
check "account 1's functions reach nothing beyond DNS on any port, as every account starts" none "$(internet_rule "$account_1")"
check "but customers' database server and cache server, on their ports only, whatever the account's internet access (ADR 0008, ADR 0013)" \
  "10.199.2.10/32:5432,10.199.2.11/32:6400-6999" "$(service_rules "$account_1")"
egress="$(with_token "$operator_token" PUT "/admin/accounts/$account_1/egress" '{"internetEgress": true, "reason": "l5: calls a payment API"}')"
check "internet egress is turned on for account 1, in its NetworkPolicy at once, FF's network still kept out, and SMTP's port 25" \
  "200 true 0.0.0.0/0 except 6 on TCP 1-24, TCP 26-65535, UDP 1-65535" \
  "$(status) $(jq -r .account.internetEgress <<<"$egress") $(internet_rule "$account_1")"
check "and account 2's functions still reach nothing beyond DNS" none "$(internet_rule "$account_2")"
storage="$(with_token "$operator_token" PUT "/admin/accounts/$account_1/storage" '{"enabled": false, "reason": "l5: files shared against the terms"}')"
check "the operator turns account 1's databases, buckets and queues off: its database's user can't log in, and its members read why in GET /me" \
  "200 suspended true l5: files shared against the terms" \
  "$(status) $(jq -r --arg id "$db_1" '.databases[] | select(.id == $id) | .status' <<<"$storage") $( (data_db_psql "$conn_1" 'select 1' || true) | grep 'is not permitted to log in' >/dev/null && echo true || echo false) $(as_user_1 GET /me | jq -r --arg id "$account_1" '.accounts[] | select(.id == $id) | .storageDisabledReason')"
as_user_1 POST /databases '{"name": "l5-while-off"}' >/dev/null
check "  ... and no database is made meanwhile" "403 FF turned this account's databases, buckets and queues off: l5: files shared against the terms" "$(status) $(message)"
check "  ... nor a queue, and no message is sent" "403 403 FF turned this account's databases, buckets and queues off: l5: files shared against the terms" \
  "$(as_user_1 POST /queues '{"name": "l5-while-off"}' >/dev/null; status) $(as_user_1 POST /queues/l5-orders-1/messages '{"body": "while off"}' >/dev/null; status) $(message)"
check "  ... nor a bucket, and its keys answer AccountProblem, saying why" "403 refused AccountProblem true" \
  "$(as_user_1 POST /buckets '{"name": "l5-while-off"}' >/dev/null; status) $(s3_with "$key_1_s3_id" "$key_1_s3_secret" "$storage_port_oidc" s3 ls s3://l5-photos-1) $(grep -q 'files shared against the terms' "$work/s3.err" && echo true || echo false)"
with_token "$operator_token" PUT "/admin/accounts/$account_1/storage" '{"enabled": true, "reason": "l5: cleared with the owner"}' >/dev/null
check "  ... on again: the user logs in, the key opens its bucket, and account 1's log names both, as FF's" "200 1 accepted account.storage,account.storage" \
  "$(status) $(data_db_psql "$conn_1" 'select 1') $(s3_with "$key_1_s3_id" "$key_1_s3_secret" "$storage_port_oidc" s3 ls s3://l5-photos-1) $(as_user_1 GET /audit-log | jq -r '[.entries[] | select(.action == "account.storage") | .action] | join(",")')"
message_out='{"from": "orders@shop.l5.example.tn", "to": ["stranger@example.org"], "subject": "l5", "text": "to anyone"}'
mail_out="$(with_token "$operator_token" PUT "/admin/accounts/$account_1/email" '{"productionAccess": true, "reason": "l5: sends its receipts"}')"
check "the operator lets account 1's mail out of the sandbox: it sends to an address it never proved" "200 false 201" \
  "$(status) $(jq -r .sandbox <<<"$mail_out") $(as_user_1 POST /email/messages "$message_out" >/dev/null; status)"
with_token "$operator_token" PUT "/admin/accounts/$account_1/email" '{"sendingEnabled": false, "reason": "l5: spam seen by a provider"}' >/dev/null
sleep 1 # the Beta plan's rate: a message a second
check "  ... pauses it: its mail refused, saying so; on again, taken; account 1's log names both, as FF's" \
  "403 Sending is paused for this account: FF's operator stopped it, and says why. 201 account.email,account.email,account.email" \
  "$(as_user_1 POST /email/messages "$message_out" >/dev/null; status) $(message) \
$(with_token "$operator_token" PUT "/admin/accounts/$account_1/email" '{"sendingEnabled": true, "reason": "l5: a list cleaned"}' >/dev/null; as_user_1 POST /email/messages "$message_out" >/dev/null; status) \
$(as_user_1 GET /audit-log | jq -r '[.entries[] | select(.action == "account.email") | .action] | join(",")')"
plan_change="$(with_token "$operator_token" PUT /admin/plans/l5-large \
  "$(jq -cn --argjson limits "$beta_limits" '{limits: ($limits | .quota = {pods: 32, cpu: "16", memory: "16Gi"}), reason: "l5: pilots need more"}')")"
check "a new quota for the plan reaches its account's namespace at once (P-73)" "200 1 0 32 16 16Gi" \
  "$(status) $(jq -r '"\(.quota.applied) \(.quota.failed)"' <<<"$plan_change") $(kubectl -n "$(tenant_namespace "$account_1")" get resourcequota ff-tenant-quota -o jsonpath='{.spec.hard.pods} {.spec.hard.limits\.cpu} {.spec.hard.limits\.memory}')"
}
section_def logs section_logs isolation admin api_keys budget=25

section_metrics() {
section "metrics, from the usage records the bill is made of"
since="$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%SZ)"
metrics_1="$(as_user_1 GET "/functions/$fn_1/metrics?period=3600&start=$since")"
metrics_status="$(status)"
recorded_1="$(sql_value \
  "SELECT count(*) FROM usage_records WHERE function_id = '$fn_1' AND status <> 'throttled' AND started_at >= date_trunc('hour', '$since'::timestamptz)")"
check "the function's Invocations, by the hour, are its usage records' calls, exactly" "200 $recorded_1 true" \
  "$metrics_status $(jq -r '[.metrics.Invocations[]] | add' <<<"$metrics_1") $(jq '[.metrics.Duration.p50[] | select(. != null)] | length > 0' <<<"$metrics_1")"
as_user_1 GET "/functions/$fn_1/metrics?period=60&start=2026-01-01T00:00:00Z" >/dev/null
check "a window of more points than an answer gives is refused, saying why" 400 "$(status)"
}
section_def metrics section_metrics isolation budget=5

section_notifications() {
section "notifications: a test to a webhook and the owners' e-mail, signed, delivered, tried again"
# verify_signature <secret...> < hook: true when the hook carries a valid v1 by each secret given, as a receiver checks it.
verify_signature() {
  python3 -c '
import hashlib, hmac, json, sys
hook = json.load(sys.stdin)
fields = [part.split("=", 1) for part in hook["headers"]["ff-signature"].split(",")]
t = dict(fields)["t"]
signatures = [value for name, value in fields if name == "v1"]
body = hook["body"]
expected = [hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest() for secret in sys.argv[1:]]
print("true" if len(signatures) == len(expected) and all(hmac.compare_digest(a, b) for a, b in zip(signatures, expected)) else "false")
' "$@"
}
# delivery_of <id>: one of account 1's deliveries, as GET /notifications/deliveries gives it.
delivery_of() { as_user_1 GET /notifications/deliveries | jq -c --arg id "$1" '.[] | select(.id == $id or .notificationId == $id)'; }
secret_1="$(as_user_1 GET /notifications/webhook-secret | jq -r .secret)"
tested="$(as_user_1 POST /notifications/test "{\"webhookUrl\": \"$receiver/l5\", \"email\": true}")"
check "account 1's owner sends a test: accepted, an e-mail and a webhook, pending" "202 email:pending webhook:pending" \
  "$(status) $(jq -r '[.deliveries[] | "\(.channel):\(.status)"] | sort | join(" ")' <<<"$tested")"
notification_1="$(jq -r .notificationId <<<"$tested")"
for _ in $(seq 1 40); do
  [ "$(delivery_of "$notification_1" | jq -s 'map(select(.status == "delivered")) | length')" = 2 ] && break
  sleep 0.5
done
check "both are delivered within seconds, once each" "delivered delivered 1 1" \
  "$(delivery_of "$notification_1" | jq -sr 'map(.status) | join(" ")') $(delivery_of "$notification_1" | jq -sr 'map(.attempts) | join(" ")')"
hook="$(webhooks_to /l5 | head -1)"
check "the receiver got it once: its FF-Event-Id the notification's, its body account 1's test" "1 $notification_1 test $account_1" \
  "$(webhooks_to /l5 | wc -l | tr -d ' ') $(jq -r '.headers["ff-event-id"]' <<<"$hook") $(jq -r '.body | fromjson | "\(.type) \(.account)"' <<<"$hook")"
check "signed with account 1's secret, as a receiver checks it" true "$(verify_signature "$secret_1" <<<"$hook")"
check "and the owner's e-mail, in their language, English" "A test notification from FF: L5 one" "$(mail_to "$user_1" | head -1)"
failing="$(as_user_1 POST /notifications/test "{\"webhookUrl\": \"$receiver/fail\"}" | jq -r '.deliveries[0].id')"
for _ in $(seq 1 40); do [ "$(delivery_of "$failing" | jq -r .lastError)" = "HTTP 500" ] && break; sleep 0.5; done
check "a receiver that answers 500: the delivery waits a minute for its next try, saying why" "pending 1 HTTP 500 500 true" \
  "$(delivery_of "$failing" | jq -r '"\(.status) \(.attempts) \(.lastError) \(.responseStatus) \(((.nextAttemptAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now) > 20)"')"
rotated="$(as_user_1 POST /notifications/webhook-secret/rotate)"
check "the owner rotates the secret: a new one, the old one signing too for a day" "200 true true" \
  "$(status) $(jq -r --arg old "$secret_1" '.secret != $old' <<<"$rotated") $(jq '((.previousExpiresAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now) > 86000' <<<"$rotated")"
as_user_1 POST /notifications/test "{\"webhookUrl\": \"$receiver/rotated\"}" >/dev/null
for _ in $(seq 1 40); do [ -n "$(webhooks_to /rotated)" ] && break; sleep 0.5; done
check "its webhooks then carry a valid signature by each" true "$(verify_signature "$(jq -r .secret <<<"$rotated")" "$secret_1" <<<"$(webhooks_to /rotated | head -1)")"
check "the rotation and the tests are in the account's audit log, never a secret" "notification.test webhook_secret.rotate false" \
  "$(as_user_1 GET /audit-log | jq -r '[.entries[] | select(.action | startswith("notification.") or startswith("webhook_secret.")) | .action] | unique | join(" ")') $(as_user_1 GET /audit-log | grep whsec_ >/dev/null && echo true || echo false)"
}
section_def notifications section_notifications signup budget=10

section_support() {
section "support: finding what a customer asks about, and its data only for a reason"
found="$(with_token "$operator_token" GET "/admin/search?q=$logged_id")"
check "the operator finds a call by its request ID: its function and account, in the history" "200 $fn_1 $account_1 true" \
  "$(status) $(jq -r '.calls[0] | "\(.functionId) \(.accountId) \(.inHistory)"' <<<"$found")"
found="$(with_token "$operator_token" GET "/admin/search?q=$user_1")"
check "and an account by its owner's e-mail" "200 $account_1" "$(status) $(jq -r '[.accounts[].id] | join(" ")' <<<"$found")"
page="$(with_token "$operator_token" GET "/admin/functions/$fn_1")"
check "the function's page: its account and its recent calls, none of what went in or out" "200 $account_1 true false" \
  "$(status) $(jq -r --arg id "$logged_id" '"\(.account.id) \([.recentCalls[].id] | index($id) != null) \(tostring | contains("\"logs\""))"' <<<"$page")"
with_token "$operator_token" POST "/admin/functions/$fn_1/invocations/$logged_id" '{}' >/dev/null
check "a call's data needs a reason" 400 "$(status)"
look="$(with_token "$operator_token" POST "/admin/functions/$fn_1/invocations/$logged_id" '{"reason": "l5: the customer asked about this call"}')"
check "given one, the call's input and output" "200 logs" "$(status) $(jq -r .input.name <<<"$look")"
look="$(with_token "$operator_token" POST "/admin/functions/$fn_1/code" '{"reason": "l5: checking the handler"}')"
check "the function's code, for a reason" "200 true" "$(status) $(jq -r '.code | contains("handler")' <<<"$look")"
look="$(with_token "$operator_token" POST "/admin/functions/$fn_1/logs" "$(jq -cn --arg id "$logged_id" '{reason: "l5: its lines", requestId: $id, sinceSeconds: 3600}')")"
check "its call's log lines, for a reason" "200 true" "$(status) $(jq '.lines | length >= 3' <<<"$look")"
looks="$(as_user_1 GET '/audit-log?limit=3')"
check "its owner reads each look in the account's audit log, as FF's, with the reason" \
  "support.view_logs:FF:l5: its lines support.view_code:FF:l5: checking the handler support.view_invocation:FF:l5: the customer asked about this call" \
  "$(jq -r '[.entries[] | "\(.action):\(.actorLabel):\(.details.reason)"] | join(" ")' <<<"$looks")"
}
section_def support section_support admin logs budget=5

section_price_books() {
section "the operator's price books (P-73)"
books="$(with_token "$operator_token" GET /admin/price-books)"
check "the first price book is active: AWS's prices at the BCT's rate; the migrations' second, with databases' and buckets' prices, starts next month" \
  "200 2 active aws-lambda 3.0080 scheduled 0.34592" \
  "$(status) $(jq -r '"\(length) \(.[0].status) \(.[0].document.source.kind) \(.[0].document.source.usdRate) \(.[1].status) \(.[1].document.prices.databaseStorageGbMonth)"' <<<"$books")"
first_book="$(jq -c '.[0].document' <<<"$books")"
latest_book="$(jq -c '.[-1].document' <<<"$books")"
starts="$(( $(date -u +%Y) + 1 ))-01-01T00:00:00Z"
with_token "$operator_token" POST /admin/price-books "$(jq -cn --arg from "$starts" --argjson doc "$first_book" '{validFrom: $from, document: $doc, reason: "l5 tries"}')" >/dev/null
check "a book after one with databases', buckets', queues', caches' and mail's prices, and what AWS bills that FF doesn't, is refused without them, each named" \
  "400 25 prices.databaseStorageGbMonth: the book before this one has it, so this one must too source.usdPrices.publicIpv4Hour: the book before this one has it, so this one must too" \
  "$(status) $(jq -r '"\(.message | length) \(.message[0]) \(.message[-1])"' "$work/body")"
created="$(with_token "$operator_token" POST /admin/price-books "$(jq -cn --arg from "$starts" --argjson doc "$latest_book" '{validFrom: $from, document: $doc, reason: "l5: next year"}')")"
check "the operator adds a book for next year from the latest: scheduled, made by the operator" "201 scheduled true" \
  "$(status) $(jq -r '"\(.status) \(.createdBy | startswith("operator:"))"' <<<"$created")"
with_token "$operator_token" POST /admin/price-books "$(jq -cn --arg from "$starts" --argjson doc "$latest_book" '{validFrom: $from, document: ($doc | .prices.requestsPerMillion = "1"), reason: "l5 tries"}')" >/dev/null
check "a book that says AWS's prices, but isn't them, is refused" "400 prices.requestsPerMillion: must be 0.20 × 3.0080 = 0.6016" "$(status) $(jq -r '.message | join("; ")' "$work/body")"
preview="$(with_token "$operator_token" POST /admin/price-books/preview "$(jq -cn --argjson doc "$latest_book" '{document: $doc}')")"
check "the operator previews it on last month, with no reason asked, as it changes nothing" "200 $(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m) TND" \
  "$(status) $(jq -r '"\(.month) \(.currency)"' <<<"$preview")"
with_token "$operator_token" DELETE "/admin/price-books/$(jq -r '.[0].id' <<<"$books")" '{"reason": "l5 tries"}' >/dev/null
check "the active book is never removed" 409 "$(status)"
with_token "$operator_token" DELETE "/admin/price-books/$(jq -r .id <<<"$created")" '{"reason": "l5: not yet"}' >/dev/null
check "a scheduled one is" "200 2" "$(status) $(with_token "$operator_token" GET /admin/price-books | jq length)"
}
section_def price_books section_price_books admin budget=5

section_transfers() {
section "bank transfers (P-35)"
typed="$(tr 'A-Z' 'a-z' <<<"${ref_1//-/}")"
found="$(with_token "$operator_token" GET "/admin/payments?reference=$typed")"
check "the operator finds account 1's pro-forma by its reference, typed from the statement without dashes" "200 $pf_1 pending 59.500 $account_1" \
  "$(status) $(jq -r '[.payments[] | "\(.id) \(.status) \(.total) \(.accountId)"] | join(",")' <<<"$found")"
before_transfer="$(as_user_1 GET /billing/balance | jq -r .balance)"
# The bank statement's day, in Tunisia, as the backend dates transfers and invoices.
today="$(TZ=Africa/Tunis date +%F)"
with_token "$operator_token" POST /admin/bank-transfers "$(transfer 58.000 0.892)" >/dev/null
check "a transfer that doesn't make the total is refused, naming the amounts" \
  "400 received 58.000 TND and withheld 0.892 TND make 58.892 TND, not the pro-forma's 59.500 TND" "$(status) $(message)"
recorded="$(with_token "$operator_token" POST /admin/bank-transfers "$(transfer 58.608 0.892)")"
check "the operator records the transfer, net of 0.892 TND withheld at source" "201 paid 58.608 0.892 49.108 operator:" \
  "$(status) $(jq -r '"\(.status) \(.transfer.received) \(.transfer.withheld) \(.transfer.credited) \(.recordedBy | sub("(?<k>operator:).*"; "\(.k)"))"' <<<"$recorded")"
check "account 1's balance grows by the credit less the withheld share, $before_transfer + 49.108 TND" \
  "$(plus_millimes "$before_transfer" 49108)" "$(as_user_1 GET /billing/balance | jq -r .balance)"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^Your transfer was received' >/dev/null && break; sleep 0.5; done
check "account 1's owner gets an e-mail: the transfer, the credit added, the withheld share to come" \
  "Your transfer was received: L5 one|58.608 TND for the pro-forma $ref_1: 49.108 TND of credit|0.892 TND was withheld at source" \
  "$(mail_to "$user_1" | head -1)|$(mail_to "$user_1" | grep -o "58.608 TND for the pro-forma $ref_1: 49.108 TND of credit")|$(mail_to "$user_1" | grep -o '0.892 TND was withheld at source')"
with_token "$operator_token" POST /admin/bank-transfers "$(transfer 58.608 0.892)" >/dev/null
check "the same transfer, recorded twice, is refused" "409 The transfer for $ref_1 was recorded on $today: 58.608 TND received" "$(status) $(message)"
printf '%%PDF-1.4\n%% l5: a withholding certificate\n' >"$work/certificate.pdf"
upload "/admin/payments/$pf_1/withholding-certificate" "$work/certificate.pdf" >/dev/null
check "a certificate without a reason is refused, which says where the reason goes" \
  "400 Every admin change needs a reason: send reason, 3 to 500 characters, in the X-FF-Reason header, URI-encoded: the body is the file" "$(status) $(message)"
certified="$(upload "/admin/payments/$pf_1/withholding-certificate" "$work/certificate.pdf" "l5: certificat de retenue reçu")"
check "with its reason in X-FF-Reason, the certificate is kept, and the withheld share credited" "200 application/pdf true" \
  "$(status) $(jq -r '"\(.certificateType) \(.transfer.withheldCreditedAt != null)"' <<<"$certified")"
check "account 1's balance now has the whole credit, $before_transfer + 50.000 TND" \
  "$(plus_millimes "$before_transfer" 50000)" "$(as_user_1 GET /billing/balance | jq -r .balance)"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^The share withheld' >/dev/null && break; sleep 0.5; done
check "and its owner an e-mail that says so" "The share withheld at source was added: L5 one" "$(mail_to "$user_1" | head -1)"
check "the reason reached the audit log as typed, accents and all" "l5: certificat de retenue reçu" \
  "$(sql_value "SELECT details->>'reason' FROM audit_log WHERE action = 'payment.withholding'")"
download="$(curl -sS -o "$work/downloaded.pdf" -w '%{http_code} %{content_type}' -H "Authorization: Bearer $operator_token" "$api_oidc/admin/payments/$pf_1/withholding-certificate")"
check "the operator downloads the certificate as it was added" "200 application/pdf true" \
  "$download $(cmp -s "$work/certificate.pdf" "$work/downloaded.pdf" && echo true || echo false)"
upload "/admin/payments/$pf_1/withholding-certificate" "$work/certificate.pdf" "l5 tries" >/dev/null
check "a second certificate is refused" "409 The certificate for $ref_1 was added on $today" "$(status) $(message)"
check "the ledger has both postings: the transfer (bank, VAT, wallet), then the certificate (receivable, wallet)" \
  "provider_clearing:-58608 vat_payable:9500 wallet:49108 wallet:892 withholding_receivable:-892" \
  "$(sql_value "
    SELECT string_agg(a.type || ':' || e.amount_minor, ' ' ORDER BY t.idempotency_key, a.type)
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE t.idempotency_key IN ('transfer:$pf_1', 'withholding:$pf_1')")"
paid="$(as_user_1 GET "/billing/pro-formas/$pf_1")"
check "account 1's owner sees the pro-forma paid: 49.108 TND credited, then the withheld share" "200 paid 49.108 true" \
  "$(status) $(jq -r '"\(.status) \(.transfer.credited) \(.transfer.withheldCreditedAt != null)"' <<<"$paid")"
log_payments="$(as_user_1 GET '/audit-log?limit=100')"
check "and, in the account's audit log, who asked for it and FF's two credits, without the operator's address" \
  "billing.pro_forma:$user_1:true payment.record:FF:null payment.withholding:FF:null" \
  "$(jq -r '[.entries[] | select(.action == "billing.pro_forma" or (.action | startswith("payment."))) | "\(.action):\(.actorLabel):\(if .actor == "operator" then .ip else (.ip != null) end)"] | reverse | join(" ")' <<<"$log_payments")"
}
section_def transfers section_transfers admin signup budget=5

section_invoices() {
section "invoices (P-36)"
# Last month as the backend's drafts take it, in Tunisia: in the hour before UTC's midnight at a month's end, the next
# month has begun there.
last_month="$(TZ=Africa/Tunis date -d "$(TZ=Africa/Tunis date +%Y-%m-01) -1 day" +%Y-%m)"
last_day="$(TZ=Africa/Tunis date -d "$(TZ=Africa/Tunis date +%Y-%m-01) -1 day" +%F)"
late="$(as_user_1 POST /billing/pro-formas '{"credit": "20"}')"
with_token "$operator_token" POST /admin/bank-transfers \
  "$(jq -cn --arg reference "$(jq -r .reference <<<"$late")" --arg on "$last_day" '{reference: $reference, received: "23.800", withheld: "0", receivedOn: $on, reason: "l5: the statement of last month"}')" >/dev/null
check "a transfer received on the last day of last month is recorded" 201 "$(status)"
drafts="$(with_token "$operator_token" GET /admin/invoices/drafts)"
check "last month's drafts: account 1's, its one payment, 19% VAT and the 1.000 TND stamp duty on top" "200 $last_month true $account_1 1 20.000 3.800 1.000 24.800" \
  "$(status) $(jq -r '"\(.month) \(.issuable) " + ([.drafts[] | "\(.accountId) \(.lines | length) \(.subtotal) \(.vat) \(.stampDuty) \(.total)"] | join(","))' <<<"$drafts")"
balance_before_invoice="$(as_user_1 GET /billing/balance | jq -r .balance)"
issued="$(with_token "$operator_token" POST /admin/invoices/issue "$(jq -cn --arg month "$last_month" '{month: $month, reason: "l5: drafts reviewed"}')")"
year="$(TZ=Africa/Tunis date +%Y)"
check "the operator issues them: one invoice, numbered first of the fiscal year, none failed" "200 FAC-$year-000001 0" \
  "$(status) $(jq -r '"\([.issued[].number] | join(",")) \(.failed | length)"' <<<"$issued")"
invoice_1="$(jq -r '.issued[0].id' <<<"$issued")"
check "the stamp duty is taken from account 1's credit: $balance_before_invoice - 1.000 TND" \
  "$(plus_millimes "$balance_before_invoice" -1000)" "$(as_user_1 GET /billing/balance | jq -r .balance)"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^Your invoice' >/dev/null && break; sleep 0.5; done
check "account 1's owner gets an e-mail, with the invoice's number" "Your invoice FAC-$year-000001: L5 one" "$(mail_to "$user_1" | head -1)"
listed_invoices="$(as_user_1 GET /billing/invoices)"
check "and lists it: its month, issue date in Tunisia and total" "200 FAC-$year-000001 invoice $last_month $(TZ=Africa/Tunis date +%F) 24.800" \
  "$(status) $(jq -r '.invoices[0] | "\(.number) \(.kind) \(.month) \(.issuedOn) \(.total)"' <<<"$listed_invoices")"
check "and downloads its PDF, named by its number" "200 application/pdf %PDF- FAC-$year-000001.pdf true" \
  "$(fetch_pdf "$api_oidc" "/billing/invoices/$invoice_1/pdf" -H "Authorization: Bearer $token_1") $(head -c 5 "$work/file.pdf") $(fetched_name) $(grep -aq "Facture FAC-$year-000001" "$work/file.pdf" && echo true || echo false)"
with_token "$token_2" GET "/billing/invoices/$invoice_1/pdf" '' -H "X-FF-Account: $account_2" >/dev/null
check "which account 2 never gets" "404 Invoice $invoice_1 not found" "$(status) $(message)"
again="$(with_token "$operator_token" POST /admin/invoices/issue "$(jq -cn --arg month "$last_month" --arg account "$account_1" '{month: $month, accountIds: [$account], reason: "l5 tries"}')")"
check "issuing it again names it, and issues nothing" "200 0 L5 one's invoice for $last_month was issued: FAC-$year-000001" \
  "$(status) $(jq -r '"\(.issued | length) \(.failed[0].problem)"' <<<"$again")"
note="$(with_token "$operator_token" POST "/admin/invoices/$invoice_1/credit-notes" '{"lines": [{"description": "Remboursement partiel", "amount": "5"}], "reason": "l5: part refunded"}')"
check "a credit note corrects it: its own numbers, 5.000 TND and 19% VAT, no stamp duty" "201 AV-$year-000001 FAC-$year-000001 5.950 0.000" \
  "$(status) $(jq -r '"\(.number) \(.corrects) \(.total) \(.stampDuty)"' <<<"$note")"
with_token "$operator_token" POST "/admin/invoices/$invoice_1/credit-notes" '{"lines": [{"description": "Trop", "amount": "15.001"}], "reason": "l5 tries"}' >/dev/null
check "and all its credit notes give back no more than it charged" \
  "400 FAC-$year-000001's credit notes would give back 20.001 TND before tax and 3.800 TND of VAT: it charged 20.000 TND and 3.800 TND" "$(status) $(message)"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^A credit note' >/dev/null && break; sleep 0.5; done
check "and its owner is told" "A credit note for your invoice FAC-$year-000001: L5 one" "$(mail_to "$user_1" | head -1)"
check "the owner's list has both, newest first" "AV-$year-000001 FAC-$year-000001" "$(as_user_1 GET /billing/invoices | jq -r '[.invoices[].number] | join(" ")')"
check "the owner downloads the month's usage statement" "200 application/pdf %PDF- releve-$(date -u +%Y-%m).pdf" \
  "$(fetch_pdf "$api_oidc" "/billing/statements/$(date -u +%Y-%m)/pdf" -H "Authorization: Bearer $token_1") $(head -c 5 "$work/file.pdf") $(fetched_name)"
check "the operator downloads the invoice too" "200 application/pdf" "$(fetch_pdf "$api_oidc" "/admin/invoices/$invoice_1/pdf" -H "Authorization: Bearer $operator_token")"
documents_1="$(with_token "$operator_token" GET "/admin/invoices?accountId=$account_1")"
check "and lists both documents of account 1" "200 AV-$year-000001,FAC-$year-000001" "$(status) $(jq -r '[.invoices[].number] | join(",")' <<<"$documents_1")"
}
section_def invoices section_invoices transfers budget=5

section_grants() {
section "credit grants (P-74)"
new_key() { cat /proc/sys/kernel/random/uuid; }
grant_body() { jq -cn --arg kind "$1" --arg amount "$2" --arg reason "$3" --arg key "$4" '{kind: $kind, amount: $amount, reason: $reason, idempotencyKey: $key}'; }
balance_before_grant="$(as_user_1 GET /billing/balance | jq -r .balance)"
balance_after_grant="$(plus_millimes "$balance_before_grant" 15000)"
promo_key="$(new_key)"
granted="$(with_token "$operator_token" POST "/admin/accounts/$account_1/credits" "$(grant_body promo 15 'l5: welcome credit' "$promo_key")")"
check "the operator grants account 1 15.000 TND of promotional credit, and gets the grant and the account page after it" \
  "201 promo 15.000 false $balance_after_grant $balance_after_grant ok" \
  "$(status) $(jq -r '"\(.grant.kind) \(.grant.amount) \(.grant.replayed) \(.grant.balance) \(.account.credit.balance) \(.account.credit.state.state)"' <<<"$granted")"
# The console's balance comes from the invoke check's cache, which the ledger's NOTIFY clears (P-33).
for _ in $(seq 1 20); do [ "$(as_user_1 GET /billing/balance | jq -r .balance)" = "$balance_after_grant" ] && break; sleep 0.25; done
check "the owner's balance has it" "$balance_after_grant" "$(as_user_1 GET /billing/balance | jq -r .balance)"
replayed="$(with_token "$operator_token" POST "/admin/accounts/$account_1/credits" "$(grant_body promo 15 'l5: welcome credit' "$promo_key")")"
check "sent again with its key, it grants once: the first grant, replayed" "201 true $(jq -r .grant.id <<<"$granted") $balance_after_grant" \
  "$(status) $(jq -r '"\(.grant.replayed) \(.grant.id)"' <<<"$replayed") $(as_user_1 GET /billing/balance | jq -r .balance)"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^FF added credit' >/dev/null && break; sleep 0.5; done
check "the owner gets an e-mail, with the reason and the balance" "FF added credit to your account: L5 one true true" \
  "$(mail_to "$user_1" | head -1) $(mail_to "$user_1" | grep '^Why: l5: welcome credit$' >/dev/null && echo true || echo false) $(mail_to "$user_1" | grep "^The balance is now $balance_after_grant TND.$" >/dev/null && echo true || echo false)"
with_token "$operator_token" POST "/admin/accounts/$account_1/credits" "$(grant_body promo 150 'l5 tries' "$(new_key)")" >/dev/null
check "above the large-credit threshold, the amount is typed again" \
  "400 150.000 TND is above the large-credit threshold, 100.000 TND: type the amount again as confirmAmount to grant it (D12)" "$(status) $(message)"
with_token "$operator_token" POST "/admin/accounts/$account_1/credits" "$(grant_body adjustment -1000 'l5 tries' "$(new_key)" | jq -c '.confirmAmount = "-1000"')" >/dev/null
check "a correction takes the credit left at most" \
  "409 Account $account_1 has $balance_after_grant TND: taking 1000.000 TND would leave it below 0.000 TND. Nothing was written" "$(status) $(message)"
corrected="$(with_token "$operator_token" POST "/admin/accounts/$account_1/credits" "$(grant_body adjustment -1.5 'l5: hours billed twice' "$(new_key)")")"
check "a correction takes 1.500 TND away" "201 adjustment -1.500 $(plus_millimes "$balance_after_grant" -1500)" \
  "$(status) $(jq -r '"\(.grant.kind) \(.grant.amount) \(.grant.balance)"' <<<"$corrected")"
with_token "$operator_token" POST "/admin/accounts/$account_1/credits" "$(grant_body promo 1 'l5 tries' "$(new_key)")" -H 'X-FF-Account: 000000000999' >/dev/null
check "an operator's grant needs no account header, and ignores one" 201 "$(status)"
with_token "$operator_token" POST "/admin/accounts/000000000999/credits" "$(grant_body promo 1 'l5 tries' "$(new_key)")" >/dev/null
check "an account that doesn't exist is named" "404 Account 000000000999 not found" "$(status) $(message)"
page_credit="$(with_token "$operator_token" GET "/admin/accounts/$account_1")"
check "the account page has the credit: balance, state, this month's charges only rated in shadow mode, the threshold" \
  "200 $(plus_millimes "$balance_after_grant" -500) ok true $(date -u +%Y-%m) 0.000 100.000" \
  "$(status) $(jq -r '.credit | "\(.balance) \(.state.state) \(.shadowMode) \(.month) \(.debited) \(.largeCreditThreshold)"' <<<"$page_credit")"
}
section_def grants section_grants transfers budget=5

section_cancel_proformas() {
section "cancelling pro-formas (P-74)"
dropped="$(as_user_1 POST /billing/pro-formas '{"credit": "30"}')"
dropped_id="$(jq -r .id <<<"$dropped")"
dropped_ref="$(jq -r .reference <<<"$dropped")"
cancelled="$(as_user_1 POST "/billing/pro-formas/$dropped_id/cancel")"
check "account 1's owner cancels a pending pro-forma" "200 cancelled true" "$(status) $(jq -r '"\(.status) \(.cancelledAt != null)"' <<<"$cancelled")"
again_cancelled="$(as_user_1 POST "/billing/pro-formas/$dropped_id/cancel")"
check "cancelling it again changes nothing" "200 cancelled $(jq -r .cancelledAt <<<"$cancelled")" "$(status) $(jq -r '"\(.status) \(.cancelledAt)"' <<<"$again_cancelled")"
as_user_1 POST "/billing/pro-formas/$pf_1/cancel" >/dev/null
check "a paid one is never cancelled" "409 The transfer for $ref_1 was recorded on $today: a paid pro-forma isn't cancelled" "$(status) $(message)"
twice="$(as_user_1 POST /billing/pro-formas '{"credit": "40"}')"
twice_id="$(jq -r .id <<<"$twice")"
twice_ref="$(jq -r .reference <<<"$twice")"
with_token "$operator_token" POST "/admin/payments/$twice_id/cancel" '{}' >/dev/null
check "an operator cancels only with a reason" "400 Every admin change needs a reason: send reason, 3 to 500 characters, in the body" "$(status) $(message)"
op_cancelled="$(with_token "$operator_token" POST "/admin/payments/$twice_id/cancel" '{"reason": "l5: asked for twice"}')"
check "the operator cancels another, with a reason" "200 cancelled true" "$(status) $(jq -r '"\(.status) \(.cancelledBy | startswith("operator:"))"' <<<"$op_cancelled")"
for _ in $(seq 1 20); do mail_to "$user_1" | head -1 | grep '^Your pro-forma' >/dev/null && break; sleep 0.5; done
check "the owner gets an e-mail that gives the reason" "Your pro-forma $twice_ref was cancelled: L5 one true" \
  "$(mail_to "$user_1" | head -1) $(mail_to "$user_1" | grep '^Why: l5: asked for twice$' >/dev/null && echo true || echo false)"
listed_cancelled="$(with_token "$operator_token" GET "/admin/payments?status=cancelled&accountId=$account_1")"
check "the operator lists account 1's cancelled pro-formas, newest first" "200 $twice_ref,$dropped_ref" "$(status) $(jq -r '[.payments[].reference] | join(",")' <<<"$listed_cancelled")"
balance_before_late="$(with_token "$operator_token" GET "/admin/accounts/$account_1" | jq -r .credit.balance)"
late_paid="$(with_token "$operator_token" POST /admin/bank-transfers \
  "$(jq -cn --arg reference "$dropped_ref" --arg on "$today" '{reference: $reference, received: "35.700", withheld: "0", receivedOn: $on, reason: "l5: it came anyway"}')")"
check "a transfer that comes for a cancelled pro-forma still pays it, keeping when it was cancelled" "201 paid true" "$(status) $(jq -r '"\(.status) \(.cancelledAt != null)"' <<<"$late_paid")"
check "and its credit reaches the wallet" "$(plus_millimes "$balance_before_late" 30000)" "$(with_token "$operator_token" GET "/admin/accounts/$account_1" | jq -r .credit.balance)"
log_cancel="$(as_user_1 GET '/audit-log?limit=100')"
check "account 1's audit log: the owner's cancel, FF's, and the transfer that came anyway" "billing.pro_forma_cancel:$user_1 payment.cancel:FF payment.record:FF" \
  "$(jq -r '[.entries[] | select(.action == "billing.pro_forma_cancel" or .action == "payment.cancel" or (.action == "payment.record" and .details.wasCancelled == true)) | "\(.action):\(.actorLabel)"] | reverse | join(" ")' <<<"$log_cancel")"
log_invoices="$(as_user_1 GET '/audit-log?limit=100')"
check "account 1's audit log has both, as FF's" "invoice.issue:FF invoice.credit_note:FF" \
  "$(jq -r '[.entries[] | select(.action | startswith("invoice.")) | "\(.action):\(.actorLabel)"] | reverse | join(" ")' <<<"$log_invoices")"
check "and the grants, as FF's, with their reasons (P-74)" "credit.promo:FF:l5: welcome credit|credit.adjustment:FF:l5: hours billed twice|credit.promo:FF:l5 tries" \
  "$(jq -r '[.entries[] | select(.action | startswith("credit.")) | "\(.action):\(.actorLabel):\(.details.reason)"] | reverse | join("|")' <<<"$log_invoices")"
by_account="$(with_token "$operator_token" GET "/admin/audit-log?accountId=$account_1")"
check "the operator audit log, filtered by account 1, lists what was done to it, oldest to newest (P-76)" \
  "200 account.approve account.suspend account.reactivate account.plan account.egress account.storage account.storage account.email account.email account.email support.view_invocation support.view_code support.view_logs payment.record payment.withholding payment.record invoice.issue invoice.credit_note credit.promo credit.adjustment credit.promo payment.cancel payment.record" \
  "$(status) $(jq -r '[.entries[].action] | reverse | join(" ")' <<<"$by_account")"
actions="$(with_token "$operator_token" GET '/admin/audit-log?action=settings.update')"
check "the operator audit log lists the change: who, what, from and to, and why (P-76)" \
  "200 operator@ff.test settings.update 24 48 l5: pilot customers asked" \
  "$(status) $(jq -r '.entries[0] | "\(.operator.email) \(.action) \(.details.changes.gracePeriodHours.from) \(.details.changes.gracePeriodHours.to) \(.reason)"' <<<"$actions")"
all_actions="$(with_token "$operator_token" GET /admin/audit-log)"
check "and, unfiltered, none of the customers' many actions: only the operator's" \
  "200 29 account.approve,account.egress,account.email,account.plan,account.reactivate,account.storage,account.suspend,credit.adjustment,credit.promo,invoice.credit_note,invoice.issue,payment.cancel,payment.record,payment.withholding,plan.create,plan.update,price_book.create,price_book.delete,settings.update,support.view_code,support.view_invocation,support.view_logs" \
  "$(status) $(jq -r '"\(.entries | length) \([.entries[].action] | unique | join(","))"' <<<"$all_actions")"
csv="$(with_token "$operator_token" GET /admin/audit-log '' -H 'accept: text/csv')"
check "as CSV too" "200 at,operator_id,operator_email,action,account_id,resource,reason,ip,request_id,details true" \
  "$(status) $(head -1 <<<"$csv" | tr -d '\r') $(grep -q ',operator@ff.test,settings.update,,settings,l5: pilot customers asked,' <<<"$csv" && echo true || echo false)"
with_token "$(keycloak_token ff-e2e "$operator_email" "$operator_password")" GET /admin/settings >/dev/null
check "the operator's token from another client is refused" "$not_admin_client" "$(status) $(message)"
with_token "$operator_token" GET /me >/dev/null
check "and the admin dashboard's token calls no customer route" \
  "403 This token was issued to the admin dashboard: the customer routes take the console's" "$(status) $(message)"
with_token "$(keycloak_token ff-admin "$user_1")" GET /admin/settings >/dev/null
check "a customer logged in through ff-admin is not an operator" "403 The admin routes are for FF's operators" "$(status) $(message)"

with_token "${token_1%?????}AAAAA" GET /functions >/dev/null
check "a tampered token: 401" "401 The token is invalid" "$(status) $(message)"
with_token "$(keycloak_token admin-cli "$user_1")" GET /functions >/dev/null
check "a token meant for another API (Keycloak's admin-cli client): 401" \
  "401 The token is not meant for this API" "$(status) $(message)"
check "A's function, history and limits are still unchanged" "$before" "$(snapshot as_a "$id")"
}
section_def cancel_proformas section_cancel_proformas transfers budget=5

section_overview() {
section "the overview: the platform at a glance, for the operator"
overview="$(with_token "$operator_token" GET /admin/stats/overview)"
check "the operator reads it" 200 "$(status)"
check "the approvals waiting, as many as the queue lists" \
  "$(with_token "$operator_token" GET '/admin/accounts?status=pending' | jq '.accounts | length')" "$(jq .accounts.pendingApprovals <<<"$overview")"
check "today's calls, as the usage records count them" \
  "$(sql_value "SELECT count(*) FILTER (WHERE status <> 'throttled') FROM usage_records WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")" \
  "$(jq .today.invocations <<<"$overview")"
check "the credit FF owes, as the wallets hold it, to the millime" \
  "$(sql_value "SELECT to_char(coalesce(sum(greatest(balance, 0)), 0) / 1000.0, 'FM999999990.000') FROM (SELECT sum(e.amount_minor) AS balance FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.ledger_account_id = a.id WHERE a.type = 'wallet' AND a.currency = 'TND' GROUP BY a.id) w")" \
  "$(jq -r '.money[] | select(.currency == "TND") | .balances.owedByFF' <<<"$overview")"
check "the invoices issued this month in Tunisia, where they are dated, the one above among them" \
  "$(sql_value "SELECT count(*) FROM invoices WHERE kind = 'invoice' AND issued_on >= date_trunc('month', now() AT TIME ZONE 'Africa/Tunis')::date") $(TZ=Africa/Tunis date +%Y-%m)" \
  "$(jq -r '"\(.invoices.issued) \(.invoices.month)"' <<<"$overview")"
check "and the last 7 days of capacity against billing" 7 "$(jq '.capacity | length' <<<"$overview")"
}
section_def overview section_overview admin budget=5

section_closing() {
section "closing an account: its functions, their history and logs deleted once its notice period has passed"
# Last, as it deletes account 1's data. By now it has a function, calls, log lines, usage, payments and invoices.
# How many lines the log store keeps of a namespace, over all it keeps.
store_lines() {
  kubectl get --raw "/api/v1/namespaces/ff-system/services/victoria-logs:http/proxy/select/logsql/query?query=$(jq -rn --arg q "{namespace=\"$1\"} | stats count() as n" '$q | @uri')" |
    jq -r '.n // "0"'
}
ns_1="$(tenant_namespace "$account_1")"
kept_1="$(sql_value "SELECT (SELECT count(*) FROM usage_records WHERE account_id = '$account_1') || ' ' || (SELECT count(*) FROM payments WHERE account_id = '$account_1') || ' ' || (SELECT count(*) FROM invoices WHERE account_id = '$account_1')")"
check "account 1 has usage records, payments and invoices, its function's code, namespace and log lines" "true true true" \
  "$(awk '{ print ($1 > 0) && ($2 > 0) && ($3 > 0) ? "true" : "false" }' <<<"$kept_1") $([ -n "$(archived "$fn_1/code.ts")" ] && echo true || echo false) $(kubectl get namespace "$ns_1" >/dev/null 2>&1 && [ "$(store_lines "$ns_1")" -gt 0 ] && echo true || echo false)"
closed="$(with_token "$operator_token" POST "/admin/accounts/$account_1/close" '{"reason": "l5: the customer left"}')"
check "the operator closes account 1: its data is due for deletion in the 30 days the settings give" "200 closed 30 null" \
  "$(status) $(jq -r '"\(.account.status) \(((.account.dataDeletionDueAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) - now) / 86400 | round) \(.account.dataDeletedAt)"' <<<"$closed")"
due_1="$(jq -r .account.dataDeletionDueAt <<<"$closed")"
check "the owner's e-mail says when, and what is kept" "Your FF account is closed: L5 one true true" \
  "$(mail_to "$user_1" | head -1) $(mail_to "$user_1" | grep "^Its functions, their invocation history and their logs will be deleted on ${due_1:0:10} at ${due_1:11:5} UTC\." >/dev/null && echo true || echo false) $(mail_to "$user_1" | grep '^Its usage, payments and invoices are kept' >/dev/null && echo true || echo false)"
check "and so does GET /me, for the console's banner" "$due_1" "$(as_user_1 GET /me | jq -r --arg id "$account_1" '.accounts[] | select(.id == $id) | .dataDeletionDueAt')"
as_user_1 GET "/functions/$fn_1" >/dev/null
check "until then, its members still read its functions" 200 "$(status)"
check "but its database's user can't log in any more (ADR 0008)" true \
  "$( (data_db_psql "$conn_1" 'select 1' || true) | grep 'is not permitted to log in' >/dev/null && echo true || echo false)"
check "nor its cache's (ADR 0013)" true "$(cache_cli "$cache_conn_1" GET l5 | grep WRONGPASS >/dev/null && echo true || echo false)"
# The notice period passes.
sql "UPDATE accounts SET data_deletion_due_at = now() WHERE id = '$account_1'"
deleted=""
for _ in $(seq 1 90); do
  deleted="$(with_token "$operator_token" GET "/admin/accounts/$account_1" | jq -r '.account.dataDeletedAt // empty')"
  [ -n "$deleted" ] && break
  sleep 1
done
check "the job deletes its data within seconds of its date: the account's page says when" true "$([ -n "$deleted" ] && echo true || echo false)"
listed_1="$(as_user_1 GET /functions | jq -c .)"
listed_status="$(status)"
as_user_1 GET "/functions/$fn_1" >/dev/null
check "its functions are gone, with their history; the account itself stays, readable" "200 [] 404 0" \
  "$listed_status $listed_1 $(status) $(sql_value "SELECT count(*) FROM function_invocations WHERE function_id = '$fn_1'")"
check "its namespace is gone from the cluster, its code from object storage, and its lines from the log store" "false empty 0" \
  "$(kubectl get namespace "$ns_1" >/dev/null 2>&1 && echo true || echo false) $([ -z "$(archived "$fn_1/code.ts")" ] && echo empty || echo kept) $(store_lines "$ns_1")"
check "its database is gone from the server, with its user" "0 0" \
  "$(docker exec -u postgres "$e2e_data_db_container" psql -XAtc "select (select count(*) from pg_database where datname = '$(jq -r .database <<<"$database_1")') || ' ' || (select count(*) from pg_roles where rolname = '$(jq -r .user <<<"$database_1")')")"
check "its cache is gone from the server, with its keys: its address answers no more" "0 true" \
  "$(sql_value "SELECT count(*) FROM caches WHERE account_id = '$account_1'") $(cache_cli "$cache_conn_1" PING | grep 'Could not connect' >/dev/null && echo true || echo false)"
check "its bucket is gone, with its files, from FF's records and the store, and its key opens nothing" "0 0 refused InvalidAccessKeyId" \
  "$(sql_value "SELECT count(*) FROM buckets WHERE account_id = '$account_1'") $(sql_value "SELECT count(*) FROM storage_keys WHERE account_id = '$account_1' AND revoked_at IS NULL") $(s3_with "$key_1_s3_id" "$key_1_s3_secret" "$storage_port_oidc" s3 ls s3://l5-photos-1)"
check "its usage records, payments and invoices are kept, as the law requires" "$kept_1" \
  "$(sql_value "SELECT (SELECT count(*) FROM usage_records WHERE account_id = '$account_1') || ' ' || (SELECT count(*) FROM payments WHERE account_id = '$account_1') || ' ' || (SELECT count(*) FROM invoices WHERE account_id = '$account_1')")"
check "its owner reads in its audit log what FF deleted, as FF" "function.delete:function:$fn_1:FF account.data_delete:account:$account_1:FF" \
  "$(as_user_1 GET '/audit-log?limit=5' | jq -r '[.entries[] | select(.action == "function.delete" or .action == "account.data_delete") | "\(.action):\(.resource):\(.actorLabel)"] | reverse | join(" ")')"
check "and GET /me says when it was done" "$deleted" "$(as_user_1 GET /me | jq -r --arg id "$account_1" '.accounts[] | select(.id == $id) | .dataDeletedAt')"
check "another account's function and namespace are untouched" "true $before" \
  "$(kubectl get namespace "$(tenant_namespace "$account_a")" >/dev/null 2>&1 && echo true || echo false) $(snapshot as_a "$id")"
}
section_def closing section_closing isolation admin budget=30

sections_run
checks_done "$E2E_NAME"

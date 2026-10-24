#!/usr/bin/env bash
# A customer's path on FF's development server (README.md), through the server's own proxy as the internet takes it,
# and nothing of it left after: an operator and a customer of the test's own, made in Keycloak through its
# administration inside the cluster; each signed in as a browser signs in, the operator setting up a one-time
# password as at a first login; an account asked for, the operator told by e-mail, and the account approved; a
# function deployed, invoked inside gVisor and called at its URL; a bucket at its own host; a queue sent to and read.
# Then everything deleted, the account closed and both users removed, whether the checks passed or not.
#   /data/ff/src/deploy/dev-server/smoke.sh        (on the server, as root: install.sh runs it after server.sh)
set -euo pipefail
home=/data/ff
secrets=$home/secrets
proxy=/data/proxy
# FF's names on this server, as the edge's settings give them (k8s/edge.env): api.<domain> and the others.
domain="$(sed -n 's/^FF_API_HOST=api\.//p' "$(dirname "${BASH_SOURCE[0]}")/k8s/edge.env")"
[ -n "$domain" ] || { echo "smoke.sh: no FF_API_HOST=api.<domain> in k8s/edge.env" >&2; exit 1; }
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml PATH="/usr/local/bin:$PATH"
work="$(mktemp -d "$home/.smoke-XXXXXX")" # readable by root alone: passwords and tokens
kc=http://127.0.0.1:18081                  # Keycloak's administration, through a port-forward
passed=0
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
run="$(hex 4)"
fail() { echo "  FAIL $*" >&2; exit 1; }
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else fail "$1 (expected '$2', got '$3')"; fi
}

# Keycloak's administration, as its bootstrap administrator: a token for each call, as one lasts a minute.
admin() { # <method> <path> [JSON file]: the answer's body in $work/admin-body; prints its status
  curl -fsS "$kc/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli -d username=admin \
    --data-urlencode "password@$secrets/keycloak-admin-password" | jq -r '"authorization: Bearer " + .access_token' >"$work/admin-header"
  curl -sS -H "@$work/admin-header" -H 'content-type: application/json' -X "$1" ${3:+-d "@$3"} -o "$work/admin-body" -w '%{http_code}' "$kc$2"
}
users=()
make_user() { # <username> <e-mail> [realm role]: the user's ID; its password in $work/<username>.password
  head -c 18 /dev/urandom | base64 | tr -d '/+=\n' >"$work/$1.password"
  jq -n --arg username "$1" --arg email "$2" --rawfile password "$work/$1.password" '{username: $username, email: $email,
    emailVerified: true, enabled: true, firstName: "Smoke", lastName: "Test", credentials: [{type: "password", value: $password, temporary: false}]}' >"$work/user.json"
  [ "$(admin POST /admin/realms/ff/users "$work/user.json")" = 201 ] || fail "Keycloak didn't make $1: $(cat "$work/admin-body")"
  admin GET "/admin/realms/ff/users?username=$1&exact=true" >/dev/null
  local id
  id="$(jq -r '.[0].id' "$work/admin-body")"
  users+=("$id")
  if [ -n "${3:-}" ]; then
    admin GET "/admin/realms/ff/roles/$3" >/dev/null
    jq '[.]' "$work/admin-body" >"$work/role.json"
    admin POST "/admin/realms/ff/users/$id/role-mappings/realm" "$work/role.json" >/dev/null
  fi
  echo "$id"
}

# Everything through the server's proxy, as a browser takes it: FF's fixed names with Let's Encrypt's certificates,
# function URLs and buckets with the proxy's own authority's, whose root the browser trusts (README.md).
{ cat /etc/ssl/certs/ca-certificates.crt
  docker compose --project-directory "$proxy" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt; } >"$work/roots.pem"
at() { # <host> [curl option...] <URL>: through the proxy; its body in $work/page, its headers in $work/headers
  local host=$1
  shift
  curl -sS --cacert "$work/roots.pem" --resolve "$host:443:127.0.0.1" -D "$work/headers" -o "$work/page" -w '%{http_code}' "$@"
}
header() { tr -d '\r' <"$work/headers" | awk -F': ' -v name="$1" 'tolower($1) == name {print $2}'; }
# <input name> [value]: the action of the page's first form with an input of that name, or that input's value.
form() {
  python3 - "$work/page" "$@" <<'PY'
import html.parser, sys
class Forms(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.forms.append((attrs.get("action") or "", {}))
        elif tag == "input" and attrs.get("name") and self.forms:
            self.forms[-1][1].setdefault(attrs["name"], attrs.get("value") or "")
forms = Forms()
forms.feed(open(sys.argv[1], encoding="utf-8").read())
match = next((f for f in forms.forms if sys.argv[2] in f[1]), None)
print("" if match is None else match[1][sys.argv[2]] if len(sys.argv) > 3 else match[0])
PY
}
totp() { # <secret>: the one-time password for now, as Keycloak's policy makes it (RFC 6238: HMAC-SHA1, 6 digits, 30 s)
  python3 -c 'import hmac, struct, sys, time
digest = hmac.new(sys.argv[1].encode(), struct.pack(">Q", int(time.time()) // 30), "sha1").digest()
offset = digest[-1] & 15
print("%06d" % ((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000))' "$1"
}
# <cookie jar>: Keycloak's redirects to its own next step, such as a required action, followed as a browser
# follows them, until one sends the browser back to the app or a page asks for something.
keycloak_steps() {
  local location
  for _ in 1 2 3 4 5; do
    location="$(header location)"
    [[ $location == "https://login.$domain/"* ]] || return 0
    at "login.$domain" -b "$1" -c "$1" "$location" >/dev/null
  done
}
login() { # <client> <app's URL> <username>: signed in as a browser is, with PKCE; its tokens in $work/<username>.tokens
  local client=$1 redirect="$2/" user=$3 verifier challenge code secret
  local jar="$work/$user.cookies"
  verifier="$(hex 32)"
  challenge="$(printf %s "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')"
  at "login.$domain" -b "$jar" -c "$jar" -G "https://login.$domain/realms/ff/protocol/openid-connect/auth" \
    --data-urlencode "client_id=$client" --data-urlencode "redirect_uri=$redirect" -d response_type=code -d scope=openid \
    -d "code_challenge=$challenge" -d code_challenge_method=S256 -d "state=$(hex 8)" >/dev/null
  at "login.$domain" -b "$jar" -c "$jar" "$(form username)" --data-urlencode "username=$user" \
    --data-urlencode "password@$work/$user.password" -d credentialId= >/dev/null
  keycloak_steps "$jar"
  # An operator's first login: its one-time password set up as the page asks, from the secret it shows.
  secret="$(form totpSecret value)"
  if [ -n "$secret" ]; then
    at "login.$domain" -b "$jar" -c "$jar" "$(form totpSecret)" -d "totp=$(totp "$secret")" --data-urlencode "totpSecret=$secret" \
      -d userLabel=smoke >/dev/null
    keycloak_steps "$jar"
  fi
  code="$(header location | python3 -c 'import sys, urllib.parse; print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip()).query).get("code", [""])[0])')"
  [ -n "$code" ] || fail "$user wasn't signed in to $client: Keycloak answered $(tr -d '\r' <"$work/headers" | head -1), to '$(header location | cut -c1-160)': $(head -c 300 "$work/page")"
  at "login.$domain" "https://login.$domain/realms/ff/protocol/openid-connect/token" -d grant_type=authorization_code \
    -d "client_id=$client" --data-urlencode "redirect_uri=$redirect" -d "code=$code" -d "code_verifier=$verifier" >/dev/null
  cp "$work/page" "$work/$user.tokens"
}
refresh() { # <client> <username>: its tokens anew, from its refresh token
  at "login.$domain" "https://login.$domain/realms/ff/protocol/openid-connect/token" -d grant_type=refresh_token \
    -d "client_id=$1" --data-urlencode "refresh_token=$(jq -r .refresh_token "$work/$2.tokens")" >/dev/null
  cp "$work/page" "$work/$2.tokens"
}
api() { # <username> <method> <path> [JSON]: the API's answer, as that user; its body in $work/page
  jq -r '"authorization: Bearer " + .access_token' "$work/$1.tokens" >"$work/api-header"
  at "api.$domain" -H "@$work/api-header" -H 'content-type: application/json' -X "$2" ${4:+-d "$4"} "https://api.$domain$3"
}

customer="smoke-$run@$domain"
# FF's realm makes each user's e-mail address its username (registrationEmailAsUsername).
operator="smoke-operator-$run@$domain"
account="" function="" bucket="" queue=""
cleanup() {
  local status=$?
  set +e
  if [ -n "$account" ]; then
    refresh ff-console "$customer" >/dev/null 2>&1
    [ -z "$function" ] || api "$customer" DELETE "/functions/$function" >/dev/null 2>&1
    [ -z "$bucket" ] || api "$customer" DELETE "/buckets/$bucket?force=true" >/dev/null 2>&1
    [ -z "$queue" ] || api "$customer" DELETE "/queues/$queue" >/dev/null 2>&1
    if [ -s "$work/$operator.tokens" ]; then
      refresh ff-admin "$operator" >/dev/null 2>&1
      api "$operator" POST "/admin/accounts/$account/close" '{"reason": "The development server smoke test, done"}' >/dev/null 2>&1
    fi
  fi
  for id in "${users[@]}"; do admin DELETE "/admin/realms/ff/users/$id" >/dev/null 2>&1; done
  [ -z "${forward:-}" ] || kill "$forward" 2>/dev/null
  rm -rf "$work"
  [ "$status" = 0 ] && echo "smoke: $passed checks passed; the account closed, its function, bucket and queue deleted, both users removed"
}
trap cleanup EXIT

echo "== an operator and a customer of the test's own"
kubectl -n ff-system port-forward service/keycloak 18081:8080 >/dev/null 2>&1 &
forward=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "$kc/realms/ff" && break; sleep 1; done
make_user "$customer" "$customer" >/dev/null
make_user "$operator" "$operator" ff-operator >/dev/null
login ff-console "https://console.$domain" "$customer"
login ff-admin "https://admin.$domain" "$operator"
check "each signed in as a browser is, the operator after setting up a one-time password" "true true" \
  "$(jq -e .access_token "$work/$customer.tokens" >/dev/null && echo true) $(jq -e .access_token "$work/$operator.tokens" >/dev/null && echo true)"

echo "== an account, asked for and approved"
mails_before="$(curl -s "http://127.0.0.1:8026/api/v1/search?query=to:operator@$domain" | jq '.messages_count // .total // 0')"
check "the customer asks for an account" 201 "$(api "$customer" POST /accounts "{\"name\": \"Smoke $run\", \"country\": \"TN\", \"useCase\": \"The development server smoke test\"}")"
account="$(jq -r .id "$work/page")"
for _ in $(seq 1 30); do
  mails="$(curl -s "http://127.0.0.1:8026/api/v1/search?query=to:operator@$domain" | jq '.messages_count // .total // 0')"
  [ "$mails" -gt "$mails_before" ] && break
  sleep 1
done
check "the operator is told by e-mail, which the server's Mailpit keeps" true "$([ "$mails" -gt "$mails_before" ] && echo true || echo false)"
check "the operator approves it, from the admin app's login" 200 "$(api "$operator" POST "/admin/accounts/$account/approve" '{"reason": "The development server smoke test"}')"

echo "== a function, inside gVisor, and at its URL"
code="import * as os from 'node:os';
export async function handler(event: { name?: string }) { return { message: \`Hello \${event.name ?? 'world'}\`, kernel: os.release() }; }"
check "the customer deploys a function" "201 ACTIVE" \
  "$(api "$customer" POST /functions "$(jq -cn --arg code "$code" '{name: "smoke", runtime: "nodejs", code: $code, memory: 128, timeout: 10}')") $(jq -r .status "$work/page")"
function="$(jq -r .id "$work/page")"
check "and invokes it: the answer, from a kernel of gVisor's" "201 Hello smoke true" \
  "$(api "$customer" POST "/functions/$function/invoke" '{"input": {"name": "smoke"}}') $(jq -r .output.message "$work/page") $(jq -r '.output.kernel | test("gvisor")' "$work/page")"
api "$customer" POST "/functions/$function/url" '{"authType": "NONE"}' >/dev/null
url="$(jq -r .functionUrl "$work/page")"
url_host="${url#https://}"
url_host="${url_host%%/*}"
check "its URL answers through the proxy, the edge's certificate made on demand" "200 Hello world" \
  "$(at "$url_host" "$url") $(jq -r .message "$work/page")"

echo "== a bucket and a queue"
bucket="smoke-$run-files"
check "a bucket" 201 "$(api "$customer" POST /buckets "{\"name\": \"$bucket\"}")"
check "at its own host, S3's refusal of an unsigned request: the edge's certificate for it made on demand" 403 \
  "$(at "$bucket.s3.$domain" "https://$bucket.s3.$domain/")"
queue="smoke-$run"
check "a queue" 201 "$(api "$customer" POST /queues "{\"name\": \"$queue\"}")"
api "$customer" POST "/queues/$queue/messages" '{"body": "{\"order\": 42}"}' >/dev/null
check "a message sent to it, and received" "200 {\"order\": 42}" \
  "$(api "$customer" POST "/queues/$queue/receive" '{"maxMessages": 1, "waitTimeSeconds": 5}') $(jq -r '.[0].body' "$work/page")"

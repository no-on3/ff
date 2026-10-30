#!/usr/bin/env bash
# A customer's path on FF's development server (README.md), through the server's own proxy as the internet takes it,
# and nothing of it left after: an operator and a customer of the test's own, made in Keycloak through its
# administration inside the cluster; each signed in as a browser signs in, the operator setting up a one-time
# password as at a first login; an account asked for, the operator told by e-mail, and the account approved; a
# function deployed, invoked inside gVisor and called at its URL; a bucket at its own host, and its site; a queue sent
# to and read; a database and a cache, reached from a function at the addresses FF gave it; an address proved by its
# link, and an e-mail from it handed to the server of customers' mail, which gives it to Mailpit. Then everything
# deleted, the account closed and both users removed, whether the checks passed or not.
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
api() { # <username> <method> <path> [JSON, or @<file> of it]: the API's answer, as that user; its body in $work/page
  jq -r '"authorization: Bearer " + .access_token' "$work/$1.tokens" >"$work/api-header"
  at "api.$domain" -H "@$work/api-header" -H 'content-type: application/json' -X "$2" ${4:+-d "$4"} "https://api.$domain$3"
}

customer="smoke-$run@$domain"
# FF's realm makes each user's e-mail address its username (registrationEmailAsUsername).
operator="smoke-operator-$run@$domain"
account="" function="" bucket="" queue="" database="" cache="" reach="" sender=""
cleanup() {
  local status=$?
  set +e
  if [ -n "$account" ]; then
    refresh ff-console "$customer" >/dev/null 2>&1
    [ -z "$function" ] || api "$customer" DELETE "/functions/$function" >/dev/null 2>&1
    [ -z "$bucket" ] || api "$customer" DELETE "/buckets/$bucket?force=true" >/dev/null 2>&1
    [ -z "$queue" ] || api "$customer" DELETE "/queues/$queue" >/dev/null 2>&1
    [ -z "$reach" ] || api "$customer" DELETE "/functions/$reach" >/dev/null 2>&1
    [ -z "$database" ] || api "$customer" DELETE "/databases/$database" >/dev/null 2>&1
    [ -z "$cache" ] || api "$customer" DELETE "/caches/$cache" >/dev/null 2>&1
    [ -z "$sender" ] || api "$customer" DELETE "/email/identities/$sender" >/dev/null 2>&1
    if [ -s "$work/$operator.tokens" ]; then
      refresh ff-admin "$operator" >/dev/null 2>&1
      api "$operator" POST "/admin/accounts/$account/close" '{"reason": "The development server smoke test, done"}' >/dev/null 2>&1
    fi
  fi
  for id in "${users[@]}"; do admin DELETE "/admin/realms/ff/users/$id" >/dev/null 2>&1; done
  [ -z "${forward:-}" ] || kill "$forward" 2>/dev/null
  rm -rf "$work"
  [ "$status" = 0 ] && echo "smoke: $passed checks passed; the account closed, all it had deleted, both users removed"
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
check "made a site, at its own host under the sites' domain" "200 https://$bucket.site.$domain" \
  "$(api "$customer" PUT "/buckets/$bucket/website" '{"indexDocument": {"suffix": "index.html"}}') $(jq -r .url "$work/page")"
check "which answers through the proxy, S3's page for a file it hasn't, the edge's certificate for it made on demand" "404 NoSuchKey" \
  "$(at "$bucket.site.$domain" "https://$bucket.site.$domain/") $(grep -oE 'Code: [A-Za-z]+' "$work/page" | head -1 | sed 's/Code: //')"
queue="smoke-$run"
check "a queue" 201 "$(api "$customer" POST /queues "{\"name\": \"$queue\"}")"
api "$customer" POST "/queues/$queue/messages" '{"body": "{\"order\": 42}"}' >/dev/null
check "a message sent to it, and received" "200 {\"order\": 42}" \
  "$(api "$customer" POST "/queues/$queue/receive" '{"maxMessages": 1, "waitTimeSeconds": 5}') $(jq -r '.[0].body' "$work/page")"

echo "== a database and a cache, from a function"
check "a database" 201 "$(api "$customer" POST /databases "{\"name\": \"smoke-$run\"}")"
database="$(jq -r .id "$work/page")"
jq -j .connectionString "$work/page" >"$work/database-url"
check "a cache, its address with its password given this once" 201 "$(api "$customer" POST /caches "{\"name\": \"smoke-$run\"}")"
cache="smoke-$run"
jq -j .url "$work/page" >"$work/cache-url"
# Each at the address FF gave, over TLS checked against the CAs FF gives functions' pods: PostgreSQL's request for TLS
# then the handshake, Valkey's AUTH then PING. The two addresses are the function's secrets, never on a command line.
cat >"$work/reach.ts" <<'TS'
import * as net from 'node:net';
import * as tls from 'node:tls';

// Why a connection failed: a refused one to a name with two addresses is an AggregateError, without a message.
const why = (error: Error & { code?: string }) => error.message || error.code || error.name;

// What a server says, or why it said nothing, within 5 seconds.
function talk(start: (done: (said: string) => void) => net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let socket: net.Socket | undefined;
    const done = (said: string) => {
      socket?.destroy();
      resolve(said);
    };
    socket = start(done);
    socket.on('error', (error) => done(why(error)));
    socket.setTimeout(5000, () => done('no answer'));
  });
}

export async function handler() {
  const db = new URL(process.env.DATABASE_URL ?? '');
  const cache = new URL(process.env.REDIS_URL ?? '');
  const database = await talk((done) => {
    const socket = net.connect(Number(db.port || 5432), db.hostname, () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once('data', (answer) => {
      if (answer.toString('latin1') !== 'S') return done('no TLS');
      const secure = tls.connect({ socket, servername: db.hostname }, () => done(secure.authorized ? 'tls' : 'not authorized'));
      secure.on('error', (error) => done(why(error)));
    });
    return socket;
  });
  const valkey = await talk((done) => {
    const socket = tls.connect({ host: cache.hostname, port: Number(cache.port), servername: cache.hostname }, () =>
      socket.write(`AUTH ${decodeURIComponent(cache.username)} ${decodeURIComponent(cache.password)}\r\nPING\r\n`),
    );
    let said = '';
    socket.on('data', (chunk) => {
      said += chunk;
      const lines = said.split('\r\n');
      if (lines.length > 2) done(lines.slice(0, 2).join(' '));
    });
    return socket;
  });
  return { database, cache: valkey };
}
TS
jq -n --rawfile code "$work/reach.ts" --rawfile database "$work/database-url" --rawfile cache "$work/cache-url" \
  '{name: "smoke-reach", runtime: "nodejs", code: $code, memory: 128, timeout: 20, secrets: {DATABASE_URL: $database, REDIS_URL: $cache}}' >"$work/reach.json"
check "a function with their addresses as its secrets" "201 ACTIVE" "$(api "$customer" POST /functions "@$work/reach.json") $(jq -r .status "$work/page")"
reach="$(jq -r .id "$work/page")"
check "which reaches both through its NetworkPolicy, their certificates checked: PostgreSQL's TLS, Valkey's AUTH and PING" "201 tls +OK +PONG" \
  "$(api "$customer" POST "/functions/$reach/invoke" '{"input": {}}') $(jq -r '.output.database + " " + .output.cache' "$work/page")"

echo "== e-mail from the account, through the server of customers' mail, into Mailpit"
sender="smoke-$run-mail@$domain"
check "an address to send from" 201 "$(api "$customer" POST /email/identities "{\"identity\": \"$sender\"}")"
mailpit() { curl -s -G "http://127.0.0.1:8026/api/v1/$1" ${2:+--data-urlencode "query=$2"}; } # <path> [search]
message=""
for _ in $(seq 1 30); do
  message="$(mailpit search "to:$sender" | jq -r '.messages[0].ID // empty')"
  [ -n "$message" ] && break
  sleep 1
done
link="$(if [ -n "$message" ]; then mailpit "message/$message" | jq -r .Text | grep -oE "https://email\.$domain/verify\?token=[A-Za-z0-9_-]+" | head -1; fi)"
check "the link FF e-mails it, which Mailpit keeps, followed: the address proved" "200 SUCCESS" \
  "$(at "email.$domain" "${link:-https://email.$domain/verify}") $(api "$customer" GET "/email/identities/$sender" >/dev/null; jq -r .status "$work/page")"
subject="Smoke $run"
check "an e-mail from it, to it, as the sandbox allows" 201 "$(api "$customer" POST /email/messages \
  "$(jq -cn --arg from "$sender" --arg subject "$subject" '{from: $from, to: [$from], subject: $subject, text: "The development server smoke test"}')")"
message=""
# Found by its sender: FF's own e-mails about the account, its approval among them, name it too.
for _ in $(seq 1 60); do
  message="$(mailpit search "from:$sender" | jq -r '.messages[0].ID // empty')"
  [ -n "$message" ] && break
  sleep 1
done
check "in Mailpit, from the server of customers' mail, its return path FF's own bounce domain" "true true" \
  "$(if [ -n "$message" ]; then
    mailpit "message/$message/headers" | jq --arg host "mail.$domain" '[.Received[]? | contains("by " + $host)] | any'
    mailpit "message/$message" | jq --arg domain "@bounces.mail.$domain" '.ReturnPath | endswith($domain)'
  else echo none; fi | paste -sd' ')"

#!/usr/bin/env bash
# A customer's path on FF's development server (README.md), through the server's own proxy as the internet takes it,
# and nothing of it left after: an operator and a customer of the test's own, made in Keycloak through its
# administration inside the cluster; each signed in as a browser signs in, the operator setting up a one-time
# password as at a first login; an account asked for, the operator told by e-mail, and the account approved; a
# function deployed, invoked inside gVisor and called at its URL; a bucket at its own host, and its site; a queue sent
# to and read; a database and a cache, reached from a function at the addresses FF gave it; a function made with the
# AWS CLI at FF's Lambda endpoint, two versions of it and an alias moved; a SAM template deployed with ff, which
# server.sh builds; an address proved by its link, and an e-mail from it handed to the server of customers' mail,
# which gives it to Mailpit. Then everything deleted, the account closed and both users removed, whether the checks
# passed or not.
#   /data/ff/src/deploy/dev-server/smoke.sh        (on the server, as root: install.sh runs it after server.sh)
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
source "$here/lib.sh"
work="$(mktemp -d "$home/.smoke-XXXXXX")" # readable by root alone: passwords and tokens
kc=http://127.0.0.1:18081                  # Keycloak's administration, through a port-forward
passed=0
run="$(hex 4)"
fail() { echo "  FAIL $*" >&2; exit 1; }
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else fail "$1 (expected '$2', got '$3')"; fi
}

proxy_roots

customer="smoke-$run@$domain"
# FF's realm makes each user's e-mail address its username (registrationEmailAsUsername).
operator="smoke-operator-$run@$domain"
account="" function="" bucket="" queue="" database="" cache="" reach="" sender="" lambda_key="" made="" stack=""
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
    [ -z "$stack" ] || ff "$stack" delete-stack --yes >/dev/null 2>&1
    [ -z "$made" ] || api "$customer" DELETE "/functions/$made" >/dev/null 2>&1
    [ -z "$lambda_key" ] || api "$customer" DELETE "/storage-keys/$lambda_key" >/dev/null 2>&1
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

echo "== Lambda's API, with the AWS CLI at FF's endpoint: a function made, two versions, an alias moved"
# The AWS CLI and ff in the AWS CLI's image (lib.sh), with the run's key and token.
docker pull -q "$aws_image" >/dev/null
lambda() { # <arguments…>: the AWS CLI's answer at Lambda's endpoint, with the run's key; its errors in $work/aws.err
  tools -w /work --env-file "$work/lambda.env" "$aws_image" lambda --endpoint-url "https://lambda.$domain" \
    --output json "$@" 2>"$work/aws.err"
}
# <zip> <version>: a package of one module, as Lambda takes one, its handler answering the version it is.
lambda_zip() {
  python3 -c 'import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    archive.writestr("index.mjs", "export const handler = async () => ({ version: %s });" % sys.argv[2])' "$1" "$2"
}
check "a key that may change the account's functions, which AWS's tools sign with" 201 \
  "$(api "$customer" POST /storage-keys "{\"name\": \"smoke-$run-lambda\", \"functions\": [\"*\"], \"functionAccess\": \"write\"}")"
lambda_key="$(jq -r .id "$work/page")"
jq -r --arg region "$region" '"AWS_ACCESS_KEY_ID=\(.id)\nAWS_SECRET_ACCESS_KEY=\(.secretAccessKey)\nAWS_DEFAULT_REGION=\($region)\nAWS_CONFIG_FILE=/dev/null\nAWS_SHARED_CREDENTIALS_FILE=/dev/null"' \
  "$work/page" >"$work/lambda.env"
lambda_zip "$work/made-1.zip" 1
lambda_zip "$work/made-2.zip" 2
name="smoke-$run-made"
state="$(lambda create-function --function-name "$name" --runtime nodejs24.x --role "arn:aws:iam::$account:role/smoke" \
  --handler index.handler --zip-file fileb://made-1.zip --publish | jq -r .State)"
api "$customer" GET "/functions?name=$name" >/dev/null
made="$(jq -r '.[0].id // empty' "$work/page")"
check "CreateFunction answers Pending, and the CLI's waiter waits for Active, inside gVisor" "Pending accepted" \
  "$state $(lambda wait function-active-v2 --function-name "$name" >/dev/null && echo accepted || head -c 300 "$work/aws.err")"
lambda update-function-code --function-name "$name" --zip-file fileb://made-2.zip >/dev/null
lambda wait function-updated-v2 --function-name "$name" >/dev/null || true
check "its code changed, and a second version published" 2 "$(lambda publish-version --function-name "$name" | jq -r .Version)"
# <the alias's version> <the call's answer>, called at the alias.
alias_call() {
  lambda invoke --function-name "$name" --qualifier live --payload '{}' --cli-binary-format raw-in-base64-out answer.json >"$work/meta.json"
  echo "$(jq -r .ExecutedVersion "$work/meta.json") $(jq -r .version "$work/answer.json")"
}
lambda create-alias --function-name "$name" --name live --function-version 1 >/dev/null
check "an alias at version 1, called" "1 1" "$(alias_call)"
lambda update-alias --function-name "$name" --name live --function-version 2 >/dev/null
check "the alias moved to version 2: the next call is version 2's" "2 2" "$(alias_call)"

echo "== a SAM template, deployed with ff: ff init's hello world, called at its URL, then its stack deleted"
ff() { ff_as "$customer" "$account" "$@"; } # <folder in the run's> <ff's arguments…>: as the customer
template="smoke-$run-sam"
check "ff init writes sam init's hello world as FF takes it" 0 "$(ff . init "$template" --runtime nodejs --template sam)"
# The folder as it is: its package.json names no library, and the image has no npm.
code="$(ff "$template" deploy template.yaml --no-build --output json)"
stack="$template"
check "ff deploy makes its function in the stack samconfig.toml names, its URL among the outputs" "0 created HelloWorldFunction true" \
  "$code $(jq -r '.functions | map("\(.action) \(.logicalId)") | join(", ")' "$work/ff.out") $(jq -r '.functions[0].url // "" | startswith("https://")' "$work/ff.out")"
url="$(jq -r '.functions[0].url' "$work/ff.out")"
url_host="${url#https://}"
url_host="${url_host%%/*}"
check "which answers at its URL through the proxy, as sam init's did at its API" "200 hello world" \
  "$(at "$url_host" "${url%/}/hello") $(jq -r .message "$work/page")"
check "ff delete-stack deletes the stack, with its function" "0 deleted the stack $template" \
  "$(ff "$template" delete-stack --yes) $(tail -n 1 "$work/ff.out")"
stack=""

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

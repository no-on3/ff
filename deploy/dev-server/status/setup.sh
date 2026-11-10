#!/usr/bin/env bash
# The status page's probe on FF's development server (../README.md, "The status page"), made or brought up to date
# on each of server.sh's runs, as root, through the server's own proxy as the internet reaches FF. Its system user,
# ff-status, whose folder is /data/ff/status; its own user in FF's realm, status-probe@<domain>, whose password
# server.sh makes once; its own account, which an operator of the script's own approves, that operator removed
# after; in that account, with ff as that user, its stack (probe/template.yaml: the canary, a function at its URL;
# the site's bucket; the queue), then the site's page; its key, made once, which reaches that bucket, queue and
# function alone; what probe.sh reads; and a copy of probe.sh outside the checkout, which ff-status can't read.
# server.sh installs its timer after.
#   /data/ff/src/deploy/dev-server/status/setup.sh       (as root: server.sh runs it, once it has built ff)
set -euo pipefail
here="$(dirname "${BASH_SOURCE[0]}")"
source "$here/../lib.sh"
status="$home/status"
work="$(mktemp -d "$home/.status-XXXXXX")" # readable by root alone: passwords, tokens and the probe's key
kc=http://127.0.0.1:18082                   # Keycloak's administration, through a port-forward
fail() { echo "status/setup.sh: $*" >&2; exit 1; }
cleanup() {
  local code=$?
  set +e
  for id in "${users[@]}"; do admin DELETE "/admin/realms/ff/users/$id" >/dev/null 2>&1; done
  [ -z "${forward:-}" ] || kill "$forward" 2>/dev/null
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT

# Its folder, which only it and root read: the minutes it writes, and what it reads, which this script writes.
id ff-status >/dev/null 2>&1 || useradd --system --user-group --home-dir "$status" --no-create-home --shell /usr/sbin/nologin ff-status
install -d -o ff-status -g ff-status -m 0750 "$status"
echo "  the user ff-status, its folder $status"

kubectl -n ff-system port-forward service/keycloak 18082:8080 >/dev/null 2>&1 &
forward=$!
for _ in $(seq 1 30); do curl -s -o /dev/null "$kc/realms/ff" && break; sleep 1; done
proxy_roots

# Its user in FF's realm, kept from run to run: made with its password, or given it again, so that it signs in
# whatever happened to it between.
probe="status-probe@$domain"
cp "$secrets/status-probe-password" "$work/$probe.password"
probe_id="$(user_id "$probe")"
if [ -z "$probe_id" ]; then
  keycloak_user "$probe" "$probe" "$work/$probe.password" >/dev/null
  echo "  $probe made, its password in $secrets/status-probe-password"
else
  jq -n --rawfile password "$work/$probe.password" '{type: "password", value: $password, temporary: false}' >"$work/password.json"
  [ "$(admin PUT "/admin/realms/ff/users/$probe_id/reset-password" "$work/password.json")" = 204 ] ||
    fail "Keycloak didn't set $probe's password: $(cat "$work/admin-body")"
fi
login ff-console "https://console.$domain" "$probe"

# Its account: the one it has, else one asked for; approved, if it waits for it, by an operator of the script's own.
[ "$(api "$probe" GET /me)" = 200 ] || fail "the API didn't answer GET /me for $probe: $(head -c 300 "$work/page")"
account="$(jq -r '[.accounts[] | select(.status == "active" or .status == "pending")][0].id // empty' "$work/page")"
if [ -z "$account" ]; then
  [ "$(api "$probe" POST /accounts '{"name": "FF status probe", "country": "TN", "useCase": "The status page: each piece of FF, probed every minute from the server"}')" = 201 ] ||
    fail "FF didn't make the probe's account: $(head -c 300 "$work/page")"
  account="$(jq -r .id "$work/page")"
  echo "  its account $account, asked for"
fi
api "$probe" GET "/accounts/$account" >/dev/null
if [ "$(jq -r .status "$work/page")" = pending ]; then
  operator="status-operator-$(hex 4)@$domain"
  make_user "$operator" "$operator" ff-operator >/dev/null
  login ff-admin "https://admin.$domain" "$operator"
  [ "$(api "$operator" POST "/admin/accounts/$account/approve" '{"reason": "The status page'"'"'s probe, set up by the server"}')" = 200 ] ||
    fail "the probe's account wasn't approved: $(head -c 300 "$work/page")"
  echo "  its account approved"
fi
[ "$(jq -r .status "$work/page")" != suspended ] || echo "  its account $account is suspended: the probe will find each of its checks refused"

# Its stack and its site's page, with ff as its user: each run, as an install may change them.
cp -r "$here/probe" "$work/probe"
[ "$(ff_as "$probe" "$account" probe deploy template.yaml --stack-name ff-status --no-build --yes --output json)" = 0 ] ||
  fail "ff didn't deploy the probe's stack: $(tail -c 600 "$work/ff.err")"
output() { jq -r --arg name "$1" '.outputs[] | select(.name == $name) | .value' "$work/ff.out"; }
canary_url="$(output CanaryUrl)" bucket="$(output SiteBucket)" queue_url="$(output QueueUrl)"
[ -n "$canary_url" ] && [ -n "$bucket" ] && [ -n "$queue_url" ] || fail "the probe's stack lacks its outputs: $(head -c 600 "$work/ff.out")"
[ "$(ff_as "$probe" "$account" probe sites deploy "$bucket" site --output json)" = 0 ] ||
  fail "ff didn't deploy the probe's site: $(tail -c 600 "$work/ff.err")"
site_url="$(jq -r .url "$work/ff.out")"
echo "  its stack ff-status: the canary at $canary_url, the site at $site_url, the queue status-probe"

# Its key, made once and kept while the account has it; else any other of its name revoked, and one made.
key_id="$(sed -n 's/^user = "\([^:]*\):.*/\1/p' "$status/probe-key.curl" 2>/dev/null || true)"
api "$probe" GET /storage-keys >/dev/null
if [ -z "$key_id" ] || ! jq -e --arg id "$key_id" 'any(.[]; .id == $id)' "$work/page" >/dev/null; then
  for old in $(jq -r '.[] | select(.name == "status-probe") | .id' "$work/page"); do api "$probe" DELETE "/storage-keys/$old" >/dev/null; done
  [ "$(ff_as "$probe" "$account" probe keys create --name status-probe --bucket "$bucket" --queue status-probe \
    --function status-canary --function-access invoke --output json)" = 0 ] || fail "ff didn't make the probe's key: $(tail -c 600 "$work/ff.err")"
  jq -r '"user = \"\(.id):\(.secretAccessKey)\""' "$work/ff.out" >"$work/probe-key.curl"
  install -o ff-status -g ff-status -m 0600 "$work/probe-key.curl" "$status/probe-key.curl"
  echo "  its key made, which reaches its bucket, queue and function alone"
fi

# What probe.sh reads, and probe.sh itself.
printf '%s\n' "domain=$domain" "region=$region" "function=status-canary" "bucket=$bucket" "queue_url=$queue_url" \
  "canary_url=$canary_url" "site_url=$site_url" >"$work/probe.env"
install -o ff-status -g ff-status -m 0640 "$work/probe.env" "$status/probe.env"
install -o ff-status -g ff-status -m 0640 "$work/roots.pem" "$status/roots.pem"
install -d -m 0755 /usr/local/lib/ff-status
install -m 0755 "$here/probe.sh" /usr/local/lib/ff-status/probe.sh

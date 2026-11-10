# shellcheck shell=bash
# What the development server's scripts share, smoke.sh and status/setup.sh, which source it: FF's names on the
# server; Keycloak's administration; a user made, and signed in as a browser signs in; FF's API as that user; and ff
# as that user, in the AWS CLI's image. Each through the server's own proxy, as the internet reaches FF.
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"     then, in the script: work, kc and fail(), before any of it runs
# work is a folder readable by root alone, as passwords and tokens go there; kc, Keycloak's administration through a
# port-forward the script makes; fail(), what the script does when a step can't go on.
lib_dir="$(dirname "${BASH_SOURCE[0]}")"
home=/data/ff
secrets=$home/secrets
proxy=/data/proxy
# FF's names on this server, as the edge's settings give them (k8s/edge.env): api.<domain> and the others.
domain="$(sed -n 's/^FF_API_HOST=api\.//p' "$lib_dir/k8s/edge.env")"
[ -n "$domain" ] || { echo "$(basename "$0"): no FF_API_HOST=api.<domain> in k8s/edge.env" >&2; exit 1; }
region=tn-tunis-1 # FF's region, the backend's own, which k8s/backend.env leaves as it is
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml PATH="/usr/local/bin:$PATH"
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Keycloak's administration, as its bootstrap administrator: a token for each call, as one lasts a minute.
admin() { # <method> <path> [JSON file]: the answer's body in $work/admin-body; prints its status
  curl -fsS "$kc/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli -d username=admin \
    --data-urlencode "password@$secrets/keycloak-admin-password" | jq -r '"authorization: Bearer " + .access_token' >"$work/admin-header"
  curl -sS -H "@$work/admin-header" -H 'content-type: application/json' -X "$1" ${3:+-d "@$3"} -o "$work/admin-body" -w '%{http_code}' "$kc$2"
}
user_id() { # <username>: the user's ID, or nothing when the realm hasn't it
  admin GET "/admin/realms/ff/users?username=$1&exact=true" >/dev/null
  jq -r '.[0].id // empty' "$work/admin-body"
}
keycloak_user() { # <username> <e-mail> <password file>: the user made, with that password; its ID printed
  jq -n --arg username "$1" --arg email "$2" --rawfile password "$3" '{username: $username, email: $email,
    emailVerified: true, enabled: true, firstName: "FF", lastName: ($username | split("@")[0]), credentials: [{type: "password", value: $password, temporary: false}]}' >"$work/user.json"
  [ "$(admin POST /admin/realms/ff/users "$work/user.json")" = 201 ] || fail "Keycloak didn't make $1: $(cat "$work/admin-body")"
  user_id "$1"
}
users=() # each user make_user made, by ID, for the script to remove
make_user() { # <username> <e-mail> [realm role]: a user of the script's own; its ID; its password in $work/<username>.password
  head -c 18 /dev/urandom | base64 | tr -d '/+=\n' >"$work/$1.password"
  local id
  id="$(keycloak_user "$1" "$2" "$work/$1.password")"
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
proxy_roots() { # $work/roots.pem: the system's CAs and the proxy's own root
  { cat /etc/ssl/certs/ca-certificates.crt
    docker compose --project-directory "$proxy" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt; } >"$work/roots.pem"
}
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
      -d "userLabel=$(basename "$0" .sh)" >/dev/null
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

# The AWS CLI and ff in the AWS CLI's image, at the suites' version, whose CA certificates check Let's Encrypt's: on
# the server's network, FF's names at its proxy, as at() takes them; the script's folder theirs. Their key and token
# are in files of the script's (--env-file), never on a command line.
aws_image=amazon/aws-cli:2.34.32
tools() { # <docker run's options and command…>
  docker run --rm --network host --add-host "api.$domain:127.0.0.1" --add-host "lambda.$domain:127.0.0.1" -v "$work:/work" "$@"
}
ff_bin="$lib_dir/../../cli/target/dist/ff-linux-x86_64" # server.sh builds it
# <username> <account> <folder in the script's> <ff's arguments…>: ff as that user, for that account; its output in
# $work/ff.out and ff.err; its status printed.
ff_as() {
  local user=$1 account=$2 folder=$3 code=0
  shift 3
  refresh ff-console "$user" >/dev/null
  jq -r --arg endpoint "https://api.$domain" --arg account "$account" \
    '"FF_ENDPOINT=\($endpoint)\nFF_ACCOUNT=\($account)\nFF_TOKEN=\(.access_token)"' "$work/$user.tokens" >"$work/ff.env"
  tools -w "/work/$folder" --env-file "$work/ff.env" -v "$(realpath "$ff_bin"):/usr/local/bin/ff:ro" --entrypoint ff \
    "$aws_image" "$@" >"$work/ff.out" 2>"$work/ff.err" || code=$?
  echo "$code"
}

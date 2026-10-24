#!/usr/bin/env bash
# FF on its development server (README.md), as root, from the checkout install.sh copied to /data/ff/src: k3s and
# gVisor; PostgreSQL, S3, mail and customers' databases beside the cluster, in Docker Compose; FF's passwords and keys,
# made once, in /data/ff/secrets; the images built here and given to k3s; deploy/k8s applied and the platform deployed
# by its deploy.sh; the first operator; FF's route in the server's own proxy (/data/proxy); then every hostname
# checked through that proxy. A step already done does nothing, so that an update is the same run. No password is
# ever printed, or put on a command line.
#   FF_VERSION=<the images' tag> FF_ADMIN_ALLOW=<address>/32 /data/ff/src/deploy/dev-server/server.sh
set -euo pipefail
home=/data/ff
src=$home/src
secrets=$home/secrets
proxy=/data/proxy
# FF's names on this server, as the edge's settings give them (k8s/edge.env): api.<domain> and the others.
domain="$(sed -n 's/^FF_API_HOST=api\.//p' "$src/deploy/dev-server/k8s/edge.env")"
version="${FF_VERSION:?the tag of the images, such as the commit}"
admin_allow="${FF_ADMIN_ALLOW:?the addresses, space apart, that reach the admin app and the administration of Keycloak}"
# What the development cluster runs (hack/k8s/env.sh, hack/k8s/gvisor-up.sh): this server runs what was tested.
k3s_version="$(sed -n 's/^export FF_K3S_IMAGE="${FF_K3S_IMAGE:-rancher\/k3s:\(.*\)}"$/\1/p' "$src/hack/k8s/env.sh" | sed 's/-k3s/+k3s/')"
gvisor_release="$(sed -n 's/^GVISOR_RELEASE="${GVISOR_RELEASE:-\(.*\)}"$/\1/p' "$src/hack/k8s/gvisor-up.sh")"
k3s_data=/data/kubernetes/k3s
edge_address=10.43.0.252 # the edge's Service, as the overlay fixes it (k8s/kustomization.yaml)
# The services beside the cluster (docker-compose.yml), <Service>:<port name>:<port docker0's address publishes>.
beside=(ff-dev-postgres:postgres:5433 ff-dev-s3:s3:8333 ff-dev-smtp:smtp:1025)
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml PATH="/usr/local/bin:$PATH"
compose=(docker compose --project-directory "$home")
work="$(mktemp -d "$home/.run-XXXXXX")" # on the data disk, readable by root alone: some files here hold secrets
trap 'rm -rf "$work"' EXIT

step() { echo "== $*"; }
fail() { echo "server.sh: $*" >&2; exit 1; }
# <file> <content> <mode>: writes it when it differs; true when it did.
write_if_changed() {
  if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then return 1; fi
  (umask 077 && printf '%s\n' "$2" >"$1.new") && chmod "$3" "$1.new" && mv "$1.new" "$1"
}

[ "$(id -u)" = 0 ] || fail "run it as root: install.sh runs it with sudo"
[ -n "$k3s_version" ] && [ -n "$gvisor_release" ] || fail "no k3s or gVisor version in $src/hack: is the checkout whole?"
[ -n "$domain" ] || fail "no FF_API_HOST=api.<domain> in $src/deploy/dev-server/k8s/edge.env"
[ -d "$proxy/sites" ] || fail "no proxy at $proxy: on this server, the projects' sites reach ports 80 and 443 through it"
id deploy >/dev/null 2>&1 || fail "no user deploy, which owns /data/<project>"
host_address="$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)"
[ -n "$host_address" ] || fail "no address on docker0, where the services beside the cluster listen"

step "FF's passwords and keys, made once ($secrets)"
install -d -o deploy -g deploy -m 0750 "$home"
install -d -o deploy -g deploy -m 0700 "$secrets"
# <name> <command...>: secrets/<name>, made by the command when there is none, readable by root and deploy alone.
secret() {
  local file="$secrets/$1"
  shift
  [ -s "$file" ] && return 0
  (umask 077 && "$@" >"$file.new") && chown deploy:deploy "$file.new" && mv "$file.new" "$file"
}
password() { head -c 24 /dev/urandom | base64 | tr -d '/+=\n'; }
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
for name in postgres-password ff-db-password keycloak-db-password keycloak-admin-password operator-password \
  s3-secret-key registry-backend-password registry-node-password data-db-superuser-password data-db-admin-password \
  grafana-password; do
  secret "$name" password
done
secret s3-access-key sh -c "printf 'ffdev%s' '$(hex 8)'"
secret log-store-delete-key hex 32
secret encryption-keys sh -c 'echo "$(date +%Y-%m):$(head -c 32 /dev/urandom | base64)"'
# The code registry's two users, bcrypt, by Apache's htpasswd in its image, each password on its stdin.
registry_users() {
  { docker run --rm -i httpd:2.4.69-alpine htpasswd -niBC 12 ff-backend <"$secrets/registry-backend-password"
    docker run --rm -i httpd:2.4.69-alpine htpasswd -niBC 12 ff-node <"$secrets/registry-node-password"; } | grep .
}
secret registry-htpasswd registry_users
secret s3.json python3 -c '
import json, sys
key, secret = (open(f"{sys.argv[1]}/{name}").read() for name in ("s3-access-key", "s3-secret-key"))
print(json.dumps({"identities": [{"name": "ff", "credentials": [{"accessKey": key, "secretKey": secret}],
  "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}))' "$secrets"

step "PostgreSQL, S3, mail and customers' databases beside the cluster, on $host_address ($home)"
install -o deploy -g deploy -m 0644 "$src/deploy/dev-server/docker-compose.yml" "$home/docker-compose.yml"
env_file="FF_HOST_ADDRESS=$host_address
FF_DOMAIN=$domain
POSTGRES_PASSWORD=$(cat "$secrets/postgres-password")
FF_DATA_DB_SUPERUSER_PASSWORD=$(cat "$secrets/data-db-superuser-password")
FF_DATA_DB_ADMIN_PASSWORD=$(cat "$secrets/data-db-admin-password")"
write_if_changed "$home/.env" "$env_file" 0600 || true
chown deploy:deploy "$home/.env"
"${compose[@]}" up -d --build --wait --quiet-pull >"$work/compose.log" 2>&1 ||
  { tail -20 "$work/compose.log" >&2; fail "the services beside the cluster didn't start"; }
# The backend's and Keycloak's databases, each with its user: made once, their passwords set each run. The SQL,
# passwords and all, goes on psql's stdin, never its command line.
for pair in ff:ff-db-password keycloak:keycloak-db-password; do
  name="${pair%%:*}"
  "${compose[@]}" exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -q >/dev/null <<SQL
SELECT 'CREATE ROLE $name LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$name') \gexec
ALTER ROLE $name PASSWORD '$(cat "$secrets/${pair#*:}")';
SELECT 'CREATE DATABASE $name OWNER $name' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$name') \gexec
SQL
done
echo "  running: $("${compose[@]}" ps --format '{{.Service}}' | sort | paste -sd' ')"

step "k3s $k3s_version, without its ingress and load balancer, and gVisor $gvisor_release"
changed=false
install -d -m 0755 /etc/rancher/k3s
write_if_changed /etc/rancher/k3s/config.yaml "# FF's development server (deploy/dev-server/server.sh). The server's proxy owns ports 80 and 443: no ingress,
# no load balancer, and node ports on the loopback alone, so that no Service is public by mistake. Secrets
# encrypted in etcd, everything on the data disk, and the node ready for gVisor.
data-dir: $k3s_data
disable: [traefik, servicelb]
secrets-encryption: true
write-kubeconfig-mode: \"0600\"
node-label: [\"ff.dev/gvisor=true\"]
kube-proxy-arg: [\"nodeport-addresses=127.0.0.1/32\"]" 0600 && changed=true
# The nodes pull code images from the registry's fixed address, as ff-node (deploy/k8s/README.md, "The code registry").
write_if_changed /etc/rancher/k3s/registries.yaml "mirrors:
  registry.ff.internal:
    endpoint:
      - \"http://10.43.0.250:5000\"
configs:
  \"10.43.0.250:5000\":
    auth:
      username: ff-node
      password: \"$(cat "$secrets/registry-node-password")\"" 0600 && changed=true
# gVisor's release, checked against the SHA-512 it is published with, as hack/k8s/gvisor-up.sh installs it.
if ! /usr/local/bin/runsc --version 2>/dev/null | grep -q "release-$gvisor_release"; then
  base="https://storage.googleapis.com/gvisor/releases/release/$gvisor_release/$(uname -m)"
  curl -fsSL --retry 3 -o "$work/gvisor.tar.zstd" "$base/gvisor.tar.zstd"
  curl -fsSL --retry 3 -o "$work/gvisor.tar.zstd.sha512" "$base/gvisor.tar.zstd.sha512"
  (cd "$work" && sha512sum -c --quiet gvisor.tar.zstd.sha512)
  files=(runsc containerd-shim-runsc-v1 gvisor-bin/gvisor_sentry gvisor-bin/gvisor-sentry-prewarmer gvisor-bin/runsc-fd-parking)
  mkdir -p "$work/gvisor" /usr/local/bin/gvisor-bin
  tar --zstd -xf "$work/gvisor.tar.zstd" -C "$work/gvisor" "${files[@]}"
  for f in "${files[@]}"; do install -m 0755 "$work/gvisor/$f" "/usr/local/bin/$f"; done
  echo "  gVisor $gvisor_release installed, its SHA-512 checked"
  changed=true
fi
install -d -m 0755 "$k3s_data/agent/etc/containerd/config-v3.toml.d"
write_if_changed "$k3s_data/agent/etc/containerd/config-v3.toml.d/10-gvisor.toml" "version = 3

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = \"io.containerd.runsc.v1\"" 0644 && changed=true
if [ "$(k3s --version 2>/dev/null | awk 'NR == 1 {print $3}')" != "$k3s_version" ]; then
  # The install script of that very release, which checks the binary against the release's SHA-256.
  curl -fsSL --retry 3 -o "$work/install-k3s.sh" "https://raw.githubusercontent.com/k3s-io/k3s/$k3s_version/install.sh"
  INSTALL_K3S_VERSION="$k3s_version" sh "$work/install-k3s.sh" >"$work/install-k3s.log" 2>&1 ||
    { tail -20 "$work/install-k3s.log" >&2; fail "k3s's installation failed"; }
  echo "  k3s $k3s_version installed"
elif [ "$changed" = true ]; then
  systemctl restart k3s
  echo "  k3s restarted for its new settings"
fi
for _ in $(seq 1 90); do kubectl get nodes 2>/dev/null | grep -q ' Ready ' && break; sleep 2; done
kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
for _ in $(seq 1 60); do kubectl -n kube-system get deployment coredns >/dev/null 2>&1 && break; sleep 2; done
kubectl -n kube-system rollout status deployment/coredns --timeout=180s >/dev/null
# Pods reach the node's API server, for CoreDNS and the backend, and its kubelet; and, at docker0's address, the
# services beside the cluster, as their Services send them to the host itself, where the firewall checks them.
# Nothing else of the node. Functions' own NetworkPolicy opens none of those services.
for port in 6443 10250; do
  ufw allow proto tcp from 10.42.0.0/16 to any port "$port" comment "FF dev server: k3s pods to the node" >/dev/null
done
for entry in "${beside[@]}"; do
  ufw allow proto tcp from 10.42.0.0/16 to "$host_address" port "${entry##*:}" comment "FF dev server: k3s pods to ${entry%%:*}" >/dev/null
done
# Customers' databases by their name, inside the cluster, where the internet's DNS doesn't answer it yet.
dns="db.$domain:53 {
    hosts {
        $host_address db.$domain
    }
}"
if [ "$(kubectl -n kube-system get configmap coredns-custom -o jsonpath='{.data.ff-dev-server\.server}' 2>/dev/null)" != "$dns" ]; then
  kubectl -n kube-system create configmap coredns-custom --from-literal=ff-dev-server.server="$dns" --dry-run=client -o yaml |
    kubectl apply --server-side --force-conflicts -f - >/dev/null
  kubectl -n kube-system rollout restart deployment/coredns >/dev/null
  kubectl -n kube-system rollout status deployment/coredns --timeout=180s >/dev/null
fi
echo "  $(kubectl get nodes --no-headers | awk '{print $1, $2, $5}'), RuntimeClass handler runsc"

step "the images, $version, built here and given to k3s"
docker build -q -t "ff-backend:$version" "$src/BE" >/dev/null
for app in console:FE admin:admin; do
  docker build -q -t "ff-${app%%:*}:$version" --build-arg VITE_API_URL="https://api.$domain" \
    --build-arg VITE_OIDC_AUTHORITY="https://login.$domain/realms/ff" "$src/${app#*:}" >/dev/null
done
docker build -q -t "ff-edge:$version" "$src/deploy/edge" >/dev/null
docker build -q -t ff-runtime-nodejs:24-v3 "$src/runtimes/nodejs" >/dev/null
docker build -q -t ff-runtime-python:3.13-v3 "$src/runtimes/python" >/dev/null
images=("ff-backend:$version" "ff-console:$version" "ff-admin:$version" "ff-edge:$version" ff-runtime-nodejs:24-v3 ff-runtime-python:3.13-v3)
docker save "${images[@]}" | k3s ctr -n k8s.io images import - >/dev/null
echo "  ${images[*]}"

step "deploy/k8s: base, the Secrets, logging, monitoring, gVisor's RuntimeClass"
kubectl apply -k "$src/deploy/k8s/base" >/dev/null
# <namespace> <name> <create secret generic's arguments...>: made or updated, server-side, so that no copy of its
# values lands in an annotation.
apply_secret() {
  local namespace=$1 name=$2
  shift 2
  kubectl -n "$namespace" create secret generic "$name" "$@" --dry-run=client -o yaml |
    kubectl apply --server-side --force-conflicts -f - >/dev/null
}
apply_secret ff-system victoria-logs-delete-key --from-file=key="$secrets/log-store-delete-key"
apply_secret ff-system ff-encryption-keys --from-file=keys="$secrets/encryption-keys"
apply_secret ff-system ff-backend --from-file=DB_PASSWORD="$secrets/ff-db-password" \
  --from-file=FF_OBJECT_STORE_ACCESS_KEY="$secrets/s3-access-key" --from-file=FF_OBJECT_STORE_SECRET_KEY="$secrets/s3-secret-key" \
  --from-literal=FF_SMTP_URL=smtp://ff-dev-smtp.ff-system.svc.cluster.local:1025 \
  --from-file=FF_CODE_REGISTRY_PASSWORD="$secrets/registry-backend-password" \
  --from-file=FF_DATA_DB_ADMIN_PASSWORD="$secrets/data-db-admin-password"
apply_secret ff-system ff-code-registry --from-file=htpasswd="$secrets/registry-htpasswd"
apply_secret ff-system keycloak --from-file=KC_DB_PASSWORD="$secrets/keycloak-db-password" \
  --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME=admin --from-file=KC_BOOTSTRAP_ADMIN_PASSWORD="$secrets/keycloak-admin-password" \
  --from-literal=FF_SMTP_PASSWORD=unused
kubectl apply -k "$src/deploy/k8s/logging" >/dev/null
kubectl apply -f "$src/deploy/k8s/monitoring/base/00-namespace.yaml" >/dev/null
apply_secret ff-monitoring alertmanager-config --from-file=alertmanager.yaml="$src/deploy/dev-server/alertmanager.yaml"
apply_secret ff-monitoring grafana-admin --from-file=password="$secrets/grafana-password"
kubectl apply -k "$src/deploy/k8s/monitoring/base" >/dev/null
kubectl apply -f "$src/deploy/k8s/optional/runtimeclass-gvisor.yaml" >/dev/null

step "the platform, with deploy/k8s/platform/deploy.sh"
overlay="$home/overlay"
rm -rf "$overlay"
install -d -m 0700 "$overlay"
# The CA of customers' databases, which the backend reads and hands to functions' pods.
"${compose[@]}" cp data-db:/var/lib/postgresql/tls/ca.crt "$overlay/data-db-ca.crt"
# The production realm, its mail to the server's Mailpit, which takes neither TLS nor a login.
python3 - "$src/deploy/k8s/platform/keycloak/ff-realm.json" "$overlay/ff-realm.json" <<'PY'
import json, sys
realm = json.load(open(sys.argv[1]))
realm["smtpServer"].update({"starttls": "false", "auth": "false"})
realm["smtpServer"].pop("user", None)
json.dump(realm, open(sys.argv[2], "w"), indent=2)
PY
# The services beside the cluster, where Compose publishes them: applied with the migrations, as their Services are.
for entry in "${beside[@]}"; do
  IFS=: read -r name port_name port <<<"$entry"
  printf -- '---\napiVersion: discovery.k8s.io/v1\nkind: EndpointSlice\nmetadata:\n  name: %s\n  namespace: ff-system\n  labels: {kubernetes.io/service-name: %s, ff.dev/deploy-step: migrations}\naddressType: IPv4\nports: [{name: %s, port: %s, protocol: TCP}]\nendpoints: [{addresses: ["%s"]}]\n' \
    "$name" "$name" "$port_name" "$port" "$host_address"
done >"$overlay/endpoints.yaml"
# The server's own proxy reaches the edge from the host: kube-proxy gives its connections the node's address on the
# pod network, the first of the node's pod range.
trusted="$(kubectl get node -o jsonpath='{.items[0].spec.podCIDR}' | sed 's#0/24$#1/32#')"
cat >"$overlay/kustomization.yaml" <<EOF
# Made by deploy/dev-server/server.sh on each run: deploy/dev-server/k8s and what is this server's own.
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../src/deploy/dev-server/k8s
  - endpoints.yaml
configMapGenerator:
  - name: ff-backend
    namespace: ff-system
    behavior: merge
    literals:
      - FF_DATA_DB_ADMIN_HOST=$host_address
      - FF_DATA_DB_CIDRS=$host_address/32
  - name: ff-edge
    namespace: ff-edge
    behavior: merge
    literals:
      - FF_ADMIN_ALLOW=$admin_allow
      - FF_EDGE_TRUSTED_PROXIES=$trusted
  - name: keycloak-realm
    namespace: ff-system
    behavior: replace
    files: [ff-realm.json]
  - name: ff-data-db-ca
    namespace: ff-system
    files: [ca.crt=data-db-ca.crt]
images:
  - {name: ff-backend, newTag: "$version"}
  - {name: ff-console, newTag: "$version"}
  - {name: ff-admin, newTag: "$version"}
  - {name: ff-edge, newTag: "$version"}
EOF
"$src/deploy/k8s/platform/deploy.sh" "$overlay" >"$work/deploy.log" 2>&1 || { tail -30 "$work/deploy.log" >&2; fail "deploy.sh failed"; }
grep -E 'executed successfully|No migrations|^platform deployed$|^functions run' "$work/deploy.log" | sed 's/^/  /'

# FF's realm makes each user's e-mail address its username (registrationEmailAsUsername).
operator="operator@$domain"
step "the first operator, $operator"
kubectl -n ff-system port-forward service/keycloak 18080:8080 >/dev/null 2>&1 &
forward=$!
trap 'kill "$forward" 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:18080/realms/ff && break; sleep 1; done
kc="http://127.0.0.1:18080"
curl -fsS "$kc/realms/master/protocol/openid-connect/token" -d grant_type=password -d client_id=admin-cli -d username=admin \
  --data-urlencode "password@$secrets/keycloak-admin-password" | python3 -c 'import json, sys; print("authorization: Bearer " + json.load(sys.stdin)["access_token"])' >"$work/admin-header"
users_named() { curl -fsS -H "@$work/admin-header" "$kc/admin/realms/ff/users?username=$1&exact=true"; }
if [ "$(users_named "$operator")" = "[]" ]; then
  python3 - "$secrets/operator-password" "$operator" >"$work/operator.json" <<'PY'
import json, sys
print(json.dumps({"username": sys.argv[2], "email": sys.argv[2], "emailVerified": True, "enabled": True,
  "firstName": "FF", "lastName": "Operator", "credentials": [{"type": "password", "value": open(sys.argv[1]).read(), "temporary": False}]}))
PY
  curl -fsS -H "@$work/admin-header" -H 'content-type: application/json' -d "@$work/operator.json" "$kc/admin/realms/ff/users"
  echo "  made, its password in $secrets/operator-password, its one-time password set at its first login"
fi
# Its role each run, which Keycloak grants once: a run stopped between the two steps leaves nothing half done.
id="$(users_named "$operator" | python3 -c 'import json, sys; print(json.load(sys.stdin)[0]["id"])')"
curl -fsS -H "@$work/admin-header" "$kc/admin/realms/ff/roles/ff-operator" | python3 -c 'import json, sys; print(json.dumps([json.load(sys.stdin)]))' >"$work/role.json"
curl -fsS -H "@$work/admin-header" -H 'content-type: application/json' -d "@$work/role.json" "$kc/admin/realms/ff/users/$id/role-mappings/realm"
echo "  $operator has the realm role ff-operator"

step "FF's route in the server's own proxy ($proxy/sites/ff.caddy)"
root="$(kubectl -n ff-edge exec deploy/ff-edge -- cat /data/caddy/pki/authorities/local/root.crt | openssl x509 -outform der | base64 -w0)"
sed -e "s|@DOMAIN@|$domain|g" -e "s|@EDGE_ADDRESS@|$edge_address|" -e "s|@EDGE_ROOT@|$root|" "$src/deploy/dev-server/ff.caddy" >"$work/ff.caddy"
if cmp -s "$work/ff.caddy" "$proxy/sites/ff.caddy"; then
  echo "  unchanged"
else
  [ -f "$proxy/sites/ff.caddy" ] && cp -p "$proxy/sites/ff.caddy" "$work/ff.caddy.before"
  install -o deploy -g deploy -m 0644 "$work/ff.caddy" "$proxy/sites/ff.caddy"
  # The proxy checks a configuration as it reloads it, and keeps the one it has when it is refused: the file goes
  # back as it was too, so that no other project's next reload meets it.
  if ! docker compose --project-directory "$proxy" exec -T caddy caddy reload --config /etc/caddy/Caddyfile >"$work/reload.log" 2>&1; then
    if [ -f "$work/ff.caddy.before" ]; then cp -p "$work/ff.caddy.before" "$proxy/sites/ff.caddy"; else rm -f "$proxy/sites/ff.caddy"; fi
    tail -5 "$work/reload.log" >&2
    fail "the proxy refused FF's route: put back as it was"
  fi
  echo "  installed, the proxy reloaded"
fi

step "every hostname, through the server's proxy, as from the internet"
# Let's Encrypt's certificates for the six fixed names, which the proxy asks for once it has the route: a minute
# or so the first time. Checked against the system's roots alone.
for name in api console admin login s3 sqs; do
  for i in $(seq 1 60); do
    curl -s -o /dev/null --cacert /etc/ssl/certs/ca-certificates.crt --resolve "$name.$domain:443:127.0.0.1" "https://$name.$domain/" && break
    [ "$i" -lt 60 ] || fail "no certificate from Let's Encrypt for $name.$domain after 3 minutes: the proxy's log says why (docker compose --project-directory $proxy logs caddy)"
    sleep 3
  done
done
# Then as a browser that trusts the system's roots and the proxy's own, which signs function URLs' and buckets'.
{ cat /etc/ssl/certs/ca-certificates.crt
  docker compose --project-directory "$proxy" exec -T caddy cat /data/caddy/pki/authorities/local/root.crt; } >"$work/roots.pem"
passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')" >&2; exit 1; fi
}
# <host> <path> [curl option...]: the answer's status, its body in $work/body, its headers in $work/headers.
at() {
  local host=$1 path=$2
  shift 2
  curl -sS --cacert "$work/roots.pem" --resolve "$host:443:127.0.0.1" -D "$work/headers" -o "$work/body" -w '%{http_code}' "$@" "https://$host$path"
}
header() { tr -d '\r' <"$work/headers" | awk -F': ' -v name="$1" 'tolower($1) == name {print $2}'; }
check "the console, with the edge's HSTS" "200 true max-age=31536000; includeSubDomains" \
  "$(at "console.$domain" /) $(grep -q '<div id="root">' "$work/body" && echo true || echo false) $(header strict-transport-security)"
check "the API: ready, its database and the cluster answering" '200 {"database":"ok","kubernetes":"ok"}' \
  "$(at "api.$domain" /readyz) $(python3 -c 'import json, sys; print(json.dumps(json.load(open(sys.argv[1]))["checks"], separators=(",", ":")))' "$work/body")"
check "the login: the realm's issuer is the public address" "200 https://login.$domain/realms/ff" \
  "$(at "login.$domain" /realms/ff/.well-known/openid-configuration) $(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["issuer"])' "$work/body")"
check "the admin app and Keycloak's administration refuse an address not allowed: this machine's" "403 403" \
  "$(at "admin.$domain" /) $(at "login.$domain" /admin/master/console/)"
check "buckets' S3 endpoint: S3's refusal of an unsigned request" 403 "$(at "s3.$domain" /)"
# A host under the function domain or the S3 endpoint that is no URL and no bucket: the edge gets no certificate for
# it, as the backend says no, so the proxy has nothing to give but its own 502.
check "a host that is no function URL, or no bucket, gets nothing from the edge" "502 502" \
  "$(at "nothing-$(hex 4).fn.$domain" /) $(at "nobody-$(hex 4).s3.$domain" /)"
check "queues' SQS endpoint: SQS's refusal of an unsigned request" "true" \
  "$(code="$(at "sqs.$domain" / -X POST)"; [ "${code:0:1}" = 4 ] && echo true || echo "false ($code)")"
echo "server.sh: $passed checks passed; FF $version is up at https://console.$domain"

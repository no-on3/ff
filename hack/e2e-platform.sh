#!/usr/bin/env bash
# L4 for the platform's manifests: a k3d cluster of its own, made from nothing, FF deployed on it only from
# deploy/k8s (base, logging, and platform through deploy.sh), then a customer's path through the edge, as the
# internet would take it.
#   - Outside the cluster, as in production: PostgreSQL (the backend's and Keycloak's databases), S3 and Mailpit,
#     containers on the cluster's network, with credentials of their own, never development's.
#   - The test overlay (hack/k8s/platform-e2e): hostnames under ff.test on port 58443, TLS from Caddy's own
#     authority, whose root the test then trusts, and the development realm, for its test client.
# It checks: TLS and HSTS on the four hostnames; the admin app and Keycloak's administration refused, then
# admitted once the operator's address is allowed; the login's issuer; a customer signing in, asking for an
# account, an operator approving it, the account deploying and invoking a function in direct mode, its inline
# code an image from the platform's registry as every function's is, inside gVisor as production requires (hack/k8s/gvisor-up.sh installs it in the cluster; deploy.sh refuses a sandbox the
# cluster lacks or no node runs), and reading its logs, the backend's token for the cluster's API lasting an
# hour; the operator's e-mail through the cluster's SMTP; the audit log naming the caller's address, not
# the edge's; a function URL over HTTPS through the edge, its certificate made on demand once the backend says
# yes, and none for a host that is no URL; a customer's own domain, proved through a DNS server beside the
# cluster, reaching the function the same way; a function made from a package, its code image pushed to the
# platform's own registry (Zot) and pulled by the node as the node is told to, which no tenant's code reaches;
# a function with AWS's SDK and no setting writing to its account's bucket with its own key, at the fixed address
# of the Service ff-storage; a queue made and read through the edge with AWS's SDK, and a function sending to it with
# its own key at the same address; the bucket a site, at its host under the sites' domain over HTTPS through the edge,
# and at a customer's own domain proved the same way; who reaches whom inside the cluster; and deploy.sh again, which
# changes nothing.
#   hack/e2e-platform.sh                  (about 15 minutes; removes its cluster and containers on exit)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
source "$FF_REPO_ROOT/hack/lib/checks.sh"
source "$FF_REPO_ROOT/hack/lib/evidence.sh"
cluster=ff-platform-e2e
prefix=ff-platform-e2e
https_port="${FF_E2E_PLATFORM_HTTPS_PORT:-58443}"
http_port="${FF_E2E_PLATFORM_HTTP_PORT:-58080}"
work="$(mktemp -d)"
export KUBECONFIG="$work/kubeconfig"
cleanup() {
  local status=$checks_status
  if [ "$status" -ne 0 ] && [ -s "$KUBECONFIG" ]; then
    echo "e2e-platform: FAILED. Pods:" >&2
    kubectl get pods -A 2>/dev/null | grep -vE 'Running|Completed' >&2 || true
    local pod
    for pod in $(kubectl get pods -A --no-headers 2>/dev/null | awk '$4 != "Running" && $4 != "Completed" {print $1 "/" $2}'); do
      echo "--- $pod" >&2
      kubectl -n "${pod%%/*}" logs "${pod#*/}" --tail=15 >&2 2>/dev/null || true
    done
    # A 500 from the API leaves its reason in the backend's log only, and the backend's pod is running.
    echo "--- the backend's last lines" >&2
    kubectl -n ff-system logs deployment/ff-backend --tail=40 >&2 2>/dev/null || true
    local evidence
    evidence="$(evidence_start e2e-platform)"
    evidence_cluster "$evidence"
    evidence_containers "$evidence" "k3d-$cluster-server-0" "$prefix-postgres" "$prefix-s3" "$prefix-mailpit" "$prefix-dns"
    evidence_logs "$evidence" "$work"
    evidence_done "$evidence" e2e-platform
  fi
  k3d cluster delete "$cluster" >/dev/null 2>&1 || true
  rm -f "$FF_KUBE_DIR/$cluster.kubeconfig"
  docker rm -f "$prefix-postgres" "$prefix-s3" "$prefix-mailpit" "$prefix-dns" >/dev/null 2>&1 || true
  # The cluster's network, which k3d keeps while the containers above are still on it.
  docker network rm "k3d-$cluster" >/dev/null 2>&1 || true
  rm -rf "$work"
}
on_exit cleanup
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
random() { head -c 18 /dev/urandom | base64 | tr -d '/+=\n'; }

section "resources"
MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-5000}" "$FF_REPO_ROOT/hack/check-resources.sh"
for port in "$https_port" "$http_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then fail "port $port is taken: set FF_E2E_PLATFORM_HTTPS_PORT and _HTTP_PORT"; fi
done

section "images"
docker build -q -t ff-backend:e2e "$FF_REPO_ROOT/BE" >/dev/null
for app in console:FE admin:admin; do
  docker build -q -t "ff-${app%%:*}:e2e" --build-arg VITE_API_URL="https://api.ff.test:$https_port" \
    --build-arg VITE_OIDC_AUTHORITY="https://login.ff.test:$https_port/realms/ff" "$FF_REPO_ROOT/${app#*:}" >/dev/null
done
docker build -q -t ff-edge:e2e "$FF_REPO_ROOT/deploy/edge" >/dev/null
docker image inspect ff-runtime-nodejs:24-v3 >/dev/null 2>&1 || docker build -q -t ff-runtime-nodejs:24-v3 "$FF_REPO_ROOT/runtimes/nodejs" >/dev/null
# The code registry's image, as the platform pins it; from ghcr.io, without the caller's Docker logins, which it may refuse.
zot_image="$(sed -n 's/^ *image: \(.*zot.*\)$/\1/p' "$FF_REPO_ROOT/deploy/k8s/platform/70-code-registry.yaml")"
mkdir -p "$work/docker" && echo '{}' >"$work/docker/config.json"
docker image inspect "$zot_image" >/dev/null 2>&1 || DOCKER_CONFIG="$work/docker" docker pull -q "$zot_image" >/dev/null
echo "  ff-backend, ff-console, ff-admin and ff-edge built, tagged e2e; $zot_image"

section "a cluster of its own"
api_port="$(free_port)"
# The node told where code images are, as an operator tells each node: the registry's fixed address, as ff-node.
node_password="$(random)"
cat >"$work/registries.yaml" <<YAML
mirrors:
  registry.ff.internal:
    endpoint:
      - "http://10.43.0.250:5000"
configs:
  "10.43.0.250:5000":
    auth:
      username: ff-node
      password: "$node_password"
YAML
k3d cluster create "$cluster" --image "$FF_K3S_IMAGE" --servers 1 --agents 0 --no-lb \
  --api-port "127.0.0.1:$api_port" --servers-memory 3g --registry-config "$work/registries.yaml" \
  --k3s-arg "--disable=traefik@server:0" --k3s-arg "--disable=metrics-server@server:0" \
  --port "127.0.0.1:$https_port:443@server:0:direct" --port "127.0.0.1:$http_port:80@server:0:direct" \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait --timeout 180s >/dev/null
k3d kubeconfig get "$cluster" >"$KUBECONFIG"
kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null
# gVisor, which production requires for functions (backend.env's K8S_RUNTIME_CLASS): gvisor-up.sh reads the
# cluster's kubeconfig where the dev scripts keep theirs.
cp "$KUBECONFIG" "$FF_KUBE_DIR/$cluster.kubeconfig"
FF_CLUSTER_NAME="$cluster" "$FF_REPO_ROOT/hack/k8s/gvisor-up.sh" >/dev/null
kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null
# A cluster in service has its DNS: the migrations' first attempts would otherwise fail on names. k3s makes
# CoreDNS's Deployment a moment after the node is ready.
for _ in $(seq 1 60); do kubectl -n kube-system get deployment coredns >/dev/null 2>&1 && break; sleep 2; done
kubectl -n kube-system rollout status deployment/coredns --timeout=180s >/dev/null
k3d image import -c "$cluster" ff-backend:e2e ff-console:e2e ff-admin:e2e ff-edge:e2e ff-runtime-nodejs:24-v3 "$zot_image" >/dev/null 2>&1
echo "  $cluster: k3s ${FF_K3S_IMAGE#*:}, the images imported"

section "outside the cluster: PostgreSQL, S3, Mailpit"
network="k3d-$cluster"
pg_admin="$(random)" ff_db="$(random)" kc_db="$(random)" s3_key="e2e$(random | cut -c1-12)" s3_secret="$(random)"
docker run -d --name "$prefix-postgres" --network "$network" -e POSTGRES_PASSWORD="$pg_admin" postgres:15-alpine >/dev/null
cat >"$work/s3.json" <<JSON
{"identities": [{"name": "ff", "credentials": [{"accessKey": "$s3_key", "secretKey": "$s3_secret"}], "actions": ["Admin", "Read", "List", "Tagging", "Write"]}]}
JSON
chmod 644 "$work/s3.json"
docker run -d --name "$prefix-s3" --network "$network" -v "$work/s3.json:/etc/seaweedfs/s3.json:ro" chrislusf/seaweedfs:4.48 \
  server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=256 >/dev/null
mail_port="$(free_port)"
docker run -d --name "$prefix-mailpit" --network "$network" -p "127.0.0.1:$mail_port:8025" axllent/mailpit:v1.31.4 >/dev/null
for _ in $(seq 1 60); do docker exec "$prefix-postgres" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$prefix-postgres" psql -U postgres -v ON_ERROR_STOP=1 -q \
  -c "CREATE USER ff PASSWORD '$ff_db'" -c "CREATE DATABASE ff OWNER ff" \
  -c "CREATE USER keycloak PASSWORD '$kc_db'" -c "CREATE DATABASE keycloak OWNER keycloak" >/dev/null
address() { docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$1"; }
endpoints() { # <service> <port name> <port> <address>
  kubectl apply -f - >/dev/null <<YAML
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata: {name: $1, namespace: ff-system, labels: {kubernetes.io/service-name: $1}}
addressType: IPv4
ports: [{name: $2, port: $3, protocol: TCP}]
endpoints: [{addresses: ["$4"]}]
YAML
}

section "deploy/k8s: base, logging, then the platform with deploy.sh"
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/base" >/dev/null
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$work/delete-key"
kubectl -n ff-system create secret generic victoria-logs-delete-key --from-file=key="$work/delete-key" >/dev/null
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/logging" >/dev/null
# The keys that encrypt functions' variables and secrets at rest: one, made for this run.
echo "e2e:$(head -c 32 /dev/urandom | base64)" >"$work/encryption-keys"
kubectl -n ff-system create secret generic ff-encryption-keys --from-file=keys="$work/encryption-keys" >/dev/null
registry_password="$(random)"
kubectl -n ff-system create secret generic ff-backend --from-literal=DB_PASSWORD="$ff_db" \
  --from-literal=FF_OBJECT_STORE_ACCESS_KEY="$s3_key" --from-literal=FF_OBJECT_STORE_SECRET_KEY="$s3_secret" \
  --from-literal=FF_SMTP_URL=smtp://ff-test-smtp.ff-system.svc.cluster.local:1025 \
  --from-literal=FF_CODE_REGISTRY_PASSWORD="$registry_password" >/dev/null
# The code registry's two users, bcrypt, as the README makes them.
{ docker run --rm httpd:2.4.69-alpine htpasswd -nbBC 10 ff-backend "$registry_password"
  docker run --rm httpd:2.4.69-alpine htpasswd -nbBC 10 ff-node "$node_password"; } | grep . >"$work/htpasswd"
kubectl -n ff-system create secret generic ff-code-registry --from-file=htpasswd="$work/htpasswd" >/dev/null
kc_admin="$(random)"
kubectl -n ff-system create secret generic keycloak --from-literal=KC_DB_PASSWORD="$kc_db" \
  --from-literal=KC_BOOTSTRAP_ADMIN_USERNAME=admin --from-literal=KC_BOOTSTRAP_ADMIN_PASSWORD="$kc_admin" \
  --from-literal=FF_SMTP_PASSWORD=unused >/dev/null
kubectl -n ff-system create configmap keycloak-realm-e2e --from-file=ff-realm.json="$FF_REPO_ROOT/deploy/keycloak/ff-realm.json" >/dev/null
kubectl apply -f "$FF_REPO_ROOT/hack/k8s/platform-e2e/external.yaml" >/dev/null
endpoints ff-test-postgres postgres 5432 "$(address "$prefix-postgres")"
endpoints ff-test-s3 s3 8333 "$(address "$prefix-s3")"
endpoints ff-test-smtp smtp 1025 "$(address "$prefix-mailpit")"
# deploy.sh refuses, before touching anything, a sandbox the cluster lacks, and one no node is labelled to run.
mkdir -p "$work/no-sandbox"
printf 'K8S_RUNTIME_CLASS=ff-missing\n' >"$work/no-sandbox/backend.env"
printf '%s\n' "resources: [$(realpath --relative-to="$work/no-sandbox" "$FF_REPO_ROOT/hack/k8s/platform-e2e")]" 'configMapGenerator:' \
  '  - {name: ff-backend, namespace: ff-system, behavior: merge, envs: [backend.env]}' >"$work/no-sandbox/kustomization.yaml"
missing=0
"$FF_REPO_ROOT/deploy/k8s/platform/deploy.sh" "$work/no-sandbox" >"$work/refused.log" 2>&1 || missing=$?
node="$(kubectl get nodes -o name | head -1)"
kubectl label "$node" ff.dev/gvisor- >/dev/null
unlabelled=0
"$FF_REPO_ROOT/deploy/k8s/platform/deploy.sh" "$FF_REPO_ROOT/hack/k8s/platform-e2e" >>"$work/refused.log" 2>&1 || unlabelled=$?
kubectl label "$node" ff.dev/gvisor=true >/dev/null
check "deploy.sh refuses a sandbox the cluster lacks, or no node runs, before deploying anything" "1 1 true true false" \
  "$missing $unlabelled $(grep -q 'RuntimeClass ff-missing, which the cluster lacks' "$work/refused.log" && echo true || echo false) $(grep -q 'no node has the label ff.dev/gvisor=true' "$work/refused.log" && echo true || echo false) $(kubectl -n ff-system get job ff-migrations >/dev/null 2>&1 && echo true || echo false)"
"$FF_REPO_ROOT/deploy/k8s/platform/deploy.sh" "$FF_REPO_ROOT/hack/k8s/platform-e2e" >"$work/deploy.log" 2>&1 \
  || { tail -30 "$work/deploy.log" >&2; fail "deploy.sh failed"; }
check "deploy.sh: the sandbox and a node for it, the registry's users, the migrations first, each run, then every rollout" "true true true true" \
  "$(grep -q '^functions run in the RuntimeClass gvisor, on 1 node(s)$' "$work/deploy.log" && echo true || echo false) $(grep -q "^the registry's users: ff-backend pushes, ff-node pulls$" "$work/deploy.log" && echo true || echo false) $(grep -q 'has been executed successfully' "$work/deploy.log" && echo true || echo false) $(grep -q '^platform deployed$' "$work/deploy.log" && echo true || echo false)"
check "and it says where the nodes pull code images" true \
  "$(grep -q "^functions' code images: registry.ff.internal, which each node's containerd maps to http://10.43.0.250:5000, as ff-node$" "$work/deploy.log" && echo true || echo false)"
grep -E 'attempt\(s\) failed' "$work/deploy.log" | sed 's/^/  note: /' || true
# The backend's token for the cluster's API is asked for an hour (deploy/k8s/platform/10-backend.yaml): the one
# Kubernetes mounts by default is valid for a year. Read in its pod, from the file the backend reads.
lifetime="$(kubectl -n ff-system exec deploy/ff-backend -- node -e "
const token = require('fs').readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
console.log(claims.exp - claims.iat)")"
check "the backend's token for the cluster's API, read in its pod, lasts an hour" 3600 "$lifetime"

section "the edge"
kubectl -n ff-edge exec deploy/ff-edge -- cat /data/caddy/pki/authorities/local/root.crt >"$work/root.crt"
resolve=()
for host in api console admin login; do resolve+=(--resolve "$host.ff.test:$https_port:127.0.0.1"); done
# https <host> <path> [curl option...]: the body; the status in $work/status, the headers in $work/headers.
https() {
  local host=$1 path=$2
  shift 2
  curl -sS --cacert "$work/root.crt" "${resolve[@]}" -D "$work/headers" -o "$work/body" -w '%{http_code}' "$@" "https://$host.ff.test:$https_port$path" >"$work/status"
  cat "$work/body"
}
status() { cat "$work/status"; }
header() { tr -d '\r' <"$work/headers" | awk -F': ' -v name="$1" 'tolower($1) == name {print $2}'; }
https console / >/dev/null
check "the console, over TLS the test verifies, with HSTS" "200 true max-age=31536000; includeSubDomains" \
  "$(status) $(grep -q '<div id="root">' "$work/body" && echo true || echo false) $(header strict-transport-security)"
check "plain HTTP sends to HTTPS, on its standard port" "308 https://console.ff.test/healthz" \
  "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --resolve "console.ff.test:$http_port:127.0.0.1" "http://console.ff.test:$http_port/healthz")"
https api /readyz >/dev/null
check "the API: ready, its database and the cluster answering" '200 {"database":"ok","kubernetes":"ok"}' "$(status) $(jq -c .checks "$work/body")"
check "the login: the realm's issuer is the public address" "https://login.ff.test:$https_port/realms/ff" \
  "$(https login /realms/ff/.well-known/openid-configuration | jq -r .issuer)"
https admin / >/dev/null
check "the admin app refuses an address not allowed" 403 "$(status)"
https login /admin/master/console/ >/dev/null
check "and so does Keycloak's administration" 403 "$(status)"
client_ip="$(kubectl -n ff-edge logs deploy/ff-edge | jq -r 'select(.request.host == "admin.ff.test:'"$https_port"'") | .request.remote_ip' | tail -1)"
kubectl -n ff-edge set env deployment/ff-edge FF_ADMIN_ALLOW="$client_ip/32" >/dev/null
kubectl -n ff-edge rollout status deployment/ff-edge --timeout=180s >/dev/null
# The new pod listens before the node's forwarding to it is in place: until then, connections are reset, and the
# old one, stopping, may still answer for a moment with the old allowlist. So until the admin app answers, a minute.
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$work/root.crt" "${resolve[@]}" "https://admin.ff.test:$https_port/")" = 200 ] && break
  sleep 1
done
https admin / >/dev/null
check "once the operator's address ($client_ip) is allowed, the admin app answers" "200 true" \
  "$(status) $(grep -q '<div id="root">' "$work/body" && echo true || echo false)"

section "a customer's path, through the edge"
admin_token="$(https login /realms/master/protocol/openid-connect/token -d grant_type=password -d client_id=admin-cli -d username=admin -d "password=$kc_admin" | jq -r .access_token)"
customer=customer@e2e.ff.test
https login /admin/realms/ff/users -H "authorization: Bearer $admin_token" -H 'content-type: application/json' -d "$(jq -cn --arg email "$customer" \
  '{username: $email, email: $email, emailVerified: true, enabled: true, firstName: "E2E", lastName: "Customer", credentials: [{type: "password", value: "e2e-password-1", temporary: false}]}')" >/dev/null
check "Keycloak's administration, from the allowed address, makes a customer" 201 "$(status)"
token="$(https login /realms/ff/protocol/openid-connect/token -d grant_type=password -d client_id=ff-e2e -d "username=$customer" -d password=e2e-password-1 | jq -r .access_token)"
operator="$(https login /realms/ff/protocol/openid-connect/token -d grant_type=password -d client_id=ff-admin -d username=operator@ff.test -d password=operator-dev-1 | jq -r .access_token)"
check "tokens from the login, for the customer and the operator" "true true" \
  "$([ "${#token}" -gt 100 ] && echo true || echo false) $([ "${#operator}" -gt 100 ] && echo true || echo false)"
as() { local who=$1; shift; https api "$@" -H "authorization: Bearer $who" -H 'content-type: application/json'; }
account="$(as "$token" /accounts -d '{"name": "E2E Platform", "country": "TN", "useCase": "The platform test"}' | jq -r .id)"
check "the customer asks for an account: it waits for approval" "201 true" "$(status) $([[ $account =~ ^[0-9]{12}$ ]] && echo true || echo false)"
for _ in $(seq 1 30); do
  mail="$(curl -s "http://127.0.0.1:$mail_port/api/v1/search?query=to:operator@ff.test" | jq -r '.messages[0].Subject // empty')"
  [ -n "$mail" ] && break
  sleep 1
done
check "the operator is told by e-mail, through the cluster's SMTP" true "$([ -n "$mail" ] && echo true || echo false)"
as "$operator" "/admin/accounts/$account/approve" -d '{"reason": "e2e: the platform test"}' >/dev/null
check "the operator approves it" 200 "$(status)"
code="import * as os from 'node:os';
export async function handler(event: { name?: string }) { return { message: \`Hello \${event.name ?? 'world'}\`, kernel: os.release() }; }"
fn="$(as "$token" /functions -d "$(jq -cn --arg code "$code" '{name: "e2e-platform", runtime: "nodejs", code: $code, memory: 128, timeout: 5}')" | jq -r .id)"
check "the customer deploys a function" "201 ACTIVE" "$(status) $(jq -r .status "$work/body")"
tenant="ff-t-$(printf %s "$account" | sha256sum | cut -c1-12)"
# The image a function's pods mount at /var/task, as the Deployment names it.
code_image() { kubectl -n "$tenant" get deployment "fn-$1" -o jsonpath='{.spec.template.spec.volumes[?(@.name=="code")].image.reference}'; }
check "its inline code is an image too, from the platform's registry, by digest, under the name the nodes map to it" true \
  "$(code_image "$fn" | grep -qE '^registry\.ff\.internal/ff-code/[0-9]{12}@sha256:[0-9a-f]{64}$' && echo true || echo false)"
# gVisor answers with a kernel of its own, not the node's.
check "and invokes it: the backend calls its Service directly, the function inside gVisor" "201 Hello platform true" \
  "$(as "$token" "/functions/$fn/invoke" -d '{"input": {"name": "platform"}}' >/dev/null; status) $(jq -r .output.message "$work/body") $(jq -r '.output.kernel | test("gvisor")' "$work/body")"
lines=0
for _ in $(seq 1 40); do
  lines="$(as "$token" "/functions/$fn/logs" -X GET | jq '[.lines[] | select(.message | startswith("REPORT"))] | length')"
  [ "$lines" -ge 1 ] && break
  sleep 1
done
check "its logs, from the cluster's log store" true "$([ "$lines" -ge 1 ] && echo true || echo false)"
check "the audit log names the caller's address, not the edge's" "$client_ip" \
  "$(as "$token" '/audit-log?limit=50' -X GET | jq -r '[.entries[] | select(.action == "function.create")][0].ip')"

section "a function from a package, through the platform's code registry"
mkdir -p "$work/package/lib"
cat >"$work/package/index.js" <<'JS'
const net = require('node:net');
exports.handler = async (event) => ({ message: require('./lib/greet')(event.name ?? 'world') });
// Whether the function's own code reaches the code registry, at the address the nodes pull from.
exports.reach = () => new Promise((resolve) => {
  const socket = net.connect({ host: '10.43.0.250', port: 5000 });
  const done = (state) => { socket.destroy(); resolve({ registry: state }); };
  socket.setTimeout(3000, () => done('refused'));
  socket.once('connect', () => done('open'));
  socket.once('error', () => done('refused'));
});
JS
echo 'module.exports = (name) => `Hello ${name}, from a package`;' >"$work/package/lib/greet.js"
(cd "$work/package" && python3 -c 'import shutil; shutil.make_archive("../package", "zip", ".")')
sha="$(https api /packages -H "authorization: Bearer $token" -H 'content-type: application/zip' --data-binary "@$work/package.zip" | jq -r .codeSha256)"
check "the customer uploads a package" 201 "$(status)"
pkg_fn="$(as "$token" /functions -d "$(jq -cn --arg sha "$sha" '{name: "e2e-package", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 128, timeout: 5}')" | jq -r .id)"
check "and makes a function of it: its code image pushed to the platform's registry, pulled by the node, mounted" "201 ACTIVE zip" \
  "$(status) $(jq -r '"\(.status) \(.packageType)"' "$work/body")"
check "which answers from its package, inside gVisor" "201 Hello platform, from a package" \
  "$(as "$token" "/functions/$pkg_fn/invoke" -d '{"input": {"name": "platform"}}' >/dev/null; status) $(jq -r .output.message "$work/body")"
check "its pods mount the image by digest, under the name the nodes map to the registry" true \
  "$(code_image "$pkg_fn" | grep -qE '^registry\.ff\.internal/ff-code/[0-9]{12}@sha256:[0-9a-f]{64}$' && echo true || echo false)"
reach_fn="$(as "$token" /functions -d "$(jq -cn --arg sha "$sha" '{name: "e2e-package-reach", runtime: "nodejs", codeSha256: $sha, handler: "index.reach", memory: 128, timeout: 5}')" | jq -r .id)"
check "a second function from the same package, the image the registry has" "201 ACTIVE" "$(status) $(jq -r .status "$work/body")"
check "whose own code doesn't reach the registry: a tenant reaches no private address" "201 refused" \
  "$(as "$token" "/functions/$reach_fn/invoke" -d '{"input": {}}' >/dev/null; status) $(jq -r .output.registry "$work/body")"

section "a function's own key to its account's buckets, at ff-storage's fixed address"
as "$token" /buckets -d '{"name": "e2e-platform-files"}' >/dev/null
check "the customer makes a bucket, at the S3 endpoint behind the edge" "201 https://s3.ff.test:$https_port" "$(status) $(jq -r .endpoint "$work/body")"
# AWS's SDK for JavaScript v3 in the package, as npm installs it: hack/e2e.sh's clients, fetched once into hack/.cache.
clients="$FF_REPO_ROOT/hack/.cache/s3-clients"
if [ ! -d "$clients/node_modules/@aws-sdk/lib-storage" ]; then
  npm install --prefix "$clients" --no-audit --no-fund --silent @aws-sdk/client-s3@3.1156.0 @aws-sdk/s3-request-presigner@3.1156.0 @aws-sdk/lib-storage@3.1156.0 >/dev/null
fi
mkdir -p "$work/s3-package"
cp "$FF_REPO_ROOT/hack/lib/s3-clients/functions/index.mjs" "$work/s3-package/"
cp -r "$clients/node_modules" "$work/s3-package/"
rm -rf "$work/s3-package/node_modules/.bin"
(cd "$work/s3-package" && python3 -c 'import shutil; shutil.make_archive("../s3-package", "zip", ".")')
s3_sha="$(https api /packages -H "authorization: Bearer $token" -H 'content-type: application/zip' --data-binary "@$work/s3-package.zip" | jq -r .codeSha256)"
s3_fn="$(as "$token" /functions -d "$(jq -cn --arg sha "$s3_sha" '{name: "e2e-s3", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 256, timeout: 20}')" | jq -r .id)"
check "a function with AWS's SDK, new S3Client({}) and no setting, writes to its account's bucket and reads it back, inside gVisor; a bucket nobody has, NoSuchBucket" \
  '201 {"read":"written by a Node.js function","other":"NoSuchBucket"}' \
  "$(as "$token" "/functions/$s3_fn/invoke" -d '{"input": {"bucket": "e2e-platform-files", "other": "e2e-platform-nobody"}}' >/dev/null; status) $(jq -c .output "$work/body")"
s3_secret_name="$(kubectl -n "$tenant" get deployment "fn-$s3_fn" -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].secretRef.name}')"
check "it reached the front door at the Service's fixed address, inside the cluster, which the backend names to its pods" "http://10.43.0.251:3002" \
  "$(kubectl -n "$tenant" get secret "$s3_secret_name" -o jsonpath='{.data.AWS_ENDPOINT_URL_S3}' | base64 -d)"

section "queues through the edge, and a function's own key to them at ff-storage's fixed address"
queue_key="$(as "$token" /storage-keys -d '{}')"
sqs_clients="$FF_REPO_ROOT/hack/.cache/sqs-clients"
if [ ! -d "$sqs_clients/node_modules/@aws-sdk/client-sqs" ]; then
  npm install --prefix "$sqs_clients" --no-audit --no-fund --silent @aws-sdk/client-sqs@3.1156.0 >/dev/null
fi
# through_edge create|receive: AWS's SDK for JavaScript v3 at the SQS endpoint behind the edge, as a customer from outside.
through_edge() {
  MODULES="$sqs_clients/node_modules" ENDPOINT="https://sqs.ff.test:$https_port" CA="$work/root.crt" KEY="$(jq -r .id <<<"$queue_key")" \
    SECRET="$(jq -r .secretAccessKey <<<"$queue_key")" QUEUE=e2e-platform-orders node "$FF_REPO_ROOT/hack/lib/sqs-clients/through-edge.mjs" "$1"
}
check "the customer makes a queue and sends a message through the edge, over TLS, its URL under the SQS endpoint" \
  "https://sqs.ff.test:$https_port/$account/e2e-platform-orders" "$(through_edge create | jq -r .url)"
mkdir -p "$work/sqs-package"
cp "$FF_REPO_ROOT/hack/lib/sqs-clients/functions/index.mjs" "$work/sqs-package/"
cp -r "$sqs_clients/node_modules" "$work/sqs-package/"
rm -rf "$work/sqs-package/node_modules/.bin"
(cd "$work/sqs-package" && python3 -c 'import shutil; shutil.make_archive("../sqs-package", "zip", ".")')
sqs_sha="$(https api /packages -H "authorization: Bearer $token" -H 'content-type: application/zip' --data-binary "@$work/sqs-package.zip" | jq -r .codeSha256)"
sqs_fn="$(as "$token" /functions -d "$(jq -cn --arg sha "$sqs_sha" '{name: "e2e-sqs", runtime: "nodejs", codeSha256: $sha, handler: "index.handler", memory: 256, timeout: 30}')" | jq -r .id)"
sqs_input="$(jq -cn --arg url "https://sqs.ff.test:$https_port/$account/e2e-platform-orders" '{input: {queue: "e2e-platform-orders", publicUrl: $url, otherAccount: "000000000000"}}')"
check "a function with AWS's SDK, new SQSClient({}) and no setting, finds the queue by its name inside the cluster, under ff-storage's address, and sends to it, in gVisor; another account's, QueueDoesNotExist" \
  "201 {\"url\":\"http://10.43.0.251:3003/$account/e2e-platform-orders\",\"byName\":\"sent\",\"keptToEndpoint\":\"sent\",\"other\":\"QueueDoesNotExist\"}" \
  "$(as "$token" "/functions/$sqs_fn/invoke" -d "$sqs_input" >/dev/null; status) $(jq -c '.output | {url, byName, keptToEndpoint, other}' "$work/body")"
sqs_secret_name="$(kubectl -n "$tenant" get deployment "fn-$sqs_fn" -o jsonpath='{.spec.template.spec.containers[0].envFrom[0].secretRef.name}')"
check "it reached the SQS endpoint at the Service's fixed address, inside the cluster, which the backend names to its pods" "http://10.43.0.251:3003" \
  "$(kubectl -n "$tenant" get secret "$sqs_secret_name" -o jsonpath='{.data.AWS_ENDPOINT_URL_SQS}' | base64 -d)"
check "the customer receives its messages through the edge, then deletes the queue" \
  '["sent by a Node.js function","sent by a Node.js function, to the URL from outside","sent through the edge"]' "$(through_edge receive | jq -c .bodies)"

section "a function's URL, through the edge"
url="$(as "$token" "/functions/$fn/url" -d '{"authType": "NONE"}' | jq -r .functionUrl)"
check "the customer gives the function a URL, under the function domain" "201 true" \
  "$(status) $([[ $url =~ ^https://[a-z0-9]{32}\.fn\.ff\.test:$https_port/$ ]] && echo true || echo false)"
url_host="${url#https://}"
url_host="${url_host%%:*}"
# The edge has no certificate for the host yet: it asks the backend, then its authority, during the first handshake.
at_url() { curl -sS --cacert "$work/root.crt" --resolve "$1:$https_port:127.0.0.1" -o "$work/body" -w '%{http_code}' "https://$1:$https_port${2:-/}"; }
check "a request over HTTPS, its certificate made on demand, reaches the function in gVisor, and its answer comes back" \
  "200 Hello world true" "$(at_url "$url_host" '/hello?name=edge') $(jq -r .message "$work/body") $(jq -r '.kernel | test("gvisor")' "$work/body")"
check "the function was told the caller's address, through the edge" "url $client_ip" \
  "$(as "$token" "/functions/$fn/invocations?limit=1" -X GET | jq -r '.invocations[0] | "\(.source) \(.input.requestContext.http.sourceIp)"')"
unknown="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n').fn.ff.test"
refused=0
at_url "$unknown" >/dev/null 2>&1 || refused=$?
check "a host that is no URL gets no certificate: the handshake fails" true "$([ "$refused" -ne 0 ] && echo true || echo false)"
asked() { kubectl -n ff-edge exec deploy/ff-edge -- wget -qO- "http://ff-backend.ff-system.svc.cluster.local:3001/tls/allowed?domain=$1" 2>/dev/null || echo no; }
check "the backend said yes for the URL's host, and no for the other, when the edge asked" "allowed no" "$(asked "$url_host") $(asked "$unknown")"

section "a customer's own domain, through the edge"
# A DNS server beside the cluster, as the customer's DNS provider would be, for the test's zone; the backend asks it.
mkdir -p "$work/zones"
zone() { # <serial> [record...]
  local serial=$1
  shift
  {
    printf '$ORIGIN e2e-customer.tn.\n$TTL 5\n@ IN SOA ns.e2e-customer.tn. hostmaster.e2e-customer.tn. %s 60 60 600 5\n' "$serial"
    printf '@ IN NS ns.e2e-customer.tn.\nns IN A 127.0.0.1\n'
    printf '%s\n' "$@"
  } >"$work/zones/e2e-customer.tn.db"
}
zone 1
printf 'e2e-customer.tn:53 {\n  file /zones/e2e-customer.tn.db {\n    reload 1s\n  }\n}\n' >"$work/zones/Corefile"
chmod 755 "$work/zones"
docker run -d --name "$prefix-dns" --network "$network" -v "$work/zones:/zones:ro" rancher/mirrored-coredns-coredns:1.14.7 -conf /zones/Corefile >/dev/null
kubectl -n ff-system set env deployment/ff-backend FF_DOMAIN_RESOLVERS="$(address "$prefix-dns"):53" >/dev/null
kubectl -n ff-system rollout status deployment/ff-backend --timeout=300s >/dev/null
added="$(as "$token" "/functions/$fn/url/domains" -d '{"domain": "shop.e2e-customer.tn"}')"
check "the customer adds a domain of theirs to the URL: pending, with the CNAME to make" "201 pending $url_host" \
  "$(status) $(jq -r '"\(.status) \(.records.cname[0].value)"' <<<"$added")"
zone 2 "shop IN CNAME $url_host."
# Until the DNS server has read the new zone, and the backend has asked it again: a minute at most.
for _ in $(seq 1 60); do
  [ "$(as "$token" /functions/$fn/url/domains/shop.e2e-customer.tn/verify -X POST | jq -r .status)" = verified ] && break
  sleep 1
done
check "once its CNAME is made, the backend proves it, asking the DNS from inside the cluster" "200 verified" \
  "$(status) $(jq -r 'if .status == "verified" then .status else "\(.status) (\(.checkError))" end' "$work/body")"
check "the domain reaches the function over HTTPS through the edge, its certificate made on demand" "200 Hello world" \
  "$(at_url shop.e2e-customer.tn '/') $(jq -r .message "$work/body")"
refused=0
at_url blog.e2e-customer.tn >/dev/null 2>&1 || refused=$?
check "a domain not proved gets no certificate: the handshake fails" true "$([ "$refused" -ne 0 ] && echo true || echo false)"

section "a bucket's site, through the edge, and a customer's own domain for it"
as "$token" /buckets/e2e-platform-files/website -X PUT -d '{"indexDocument": {"suffix": "index.html"}}' >/dev/null
check "the customer makes the bucket a site, at its own host under the sites' domain" "200 https://e2e-platform-files.site.ff.test:$https_port" \
  "$(status) $(jq -r .url "$work/body")"
check "the function's file answers there over HTTPS, typed by its name, the site's certificate made on demand" \
  "200 written by a Node.js function text/plain" \
  "$(at_url e2e-platform-files.site.ff.test /from-node.txt) $(cat "$work/body") $(curl -sS --cacert "$work/root.crt" --resolve "e2e-platform-files.site.ff.test:$https_port:127.0.0.1" \
    -o /dev/null -w '%{content_type}' "https://e2e-platform-files.site.ff.test:$https_port/from-node.txt" | cut -d';' -f1)"
refused=0
at_url e2e-platform-nosite.site.ff.test >/dev/null 2>&1 || refused=$?
check "a host under the sites' domain that is no site gets no certificate: the handshake fails" true "$([ "$refused" -ne 0 ] && echo true || echo false)"
added="$(as "$token" /buckets/e2e-platform-files/website/domains -d '{"domain": "docs.e2e-customer.tn"}')"
check "the customer adds a domain of theirs to the site: pending, with the CNAME to make, to the site's host" "201 pending e2e-platform-files.site.ff.test" \
  "$(status) $(jq -r '"\(.status) \(.records.cname[0].value)"' <<<"$added")"
zone 3 "shop IN CNAME $url_host." "docs IN CNAME e2e-platform-files.site.ff.test."
for _ in $(seq 1 60); do
  [ "$(as "$token" /buckets/e2e-platform-files/website/domains/docs.e2e-customer.tn/verify -X POST | jq -r .status)" = verified ] && break
  sleep 1
done
check "once its CNAME is made, the backend proves it" "200 verified" \
  "$(status) $(jq -r 'if .status == "verified" then .status else "\(.status) (\(.checkError))" end' "$work/body")"
check "the domain reaches the site over HTTPS through the edge, its certificate made on demand" "200 written by a Node.js function" \
  "$(at_url docs.e2e-customer.tn /from-node.txt) $(cat "$work/body")"

section "who reaches whom inside the cluster"
kubectl create namespace e2e-probe >/dev/null
kubectl -n e2e-probe run probe --image=ff-runtime-nodejs:24-v3 --image-pull-policy=Never --restart=Never --command -- node -e '
const net = require("node:net");
const targets = { edge: ["ff-edge.ff-edge.svc", 443], backend: ["ff-backend.ff-system.svc", 80], urls: ["ff-backend.ff-system.svc", 3001], keycloak: ["keycloak.ff-system.svc", 8080],
  console: ["ff-console.ff-system.svc", 80], registry: ["ff-code-registry.ff-system.svc", 5000], buckets: ["10.43.0.251", 3002], queues: ["10.43.0.251", 3003],
  function: [process.argv[1], 8080] };
Promise.all(Object.entries(targets).map(([name, [host, port]]) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (state) => { socket.destroy(); resolve(name + "=" + state); };
  socket.setTimeout(3000, () => done("refused"));
  socket.once("connect", () => done("open"));
  socket.once("error", () => done("refused"));
}))).then((states) => console.log(states.join(" ")));' "fn-$fn.ff-t-$(printf %s "$account" | sha256sum | cut -c1-12).svc" >/dev/null
kubectl -n e2e-probe wait --for=jsonpath='{.status.phase}'=Succeeded pod/probe --timeout=120s >/dev/null || true
check "an ordinary pod reaches the edge, and neither the backend, its port for function URLs, Keycloak, the console, the code registry, buckets' and queues' address for functions nor a function" \
  "edge=open backend=refused urls=refused keycloak=refused console=refused registry=refused buckets=refused queues=refused function=refused" "$(kubectl -n e2e-probe logs probe | tail -1)"

section "deploy.sh again"
"$FF_REPO_ROOT/deploy/k8s/platform/deploy.sh" "$FF_REPO_ROOT/hack/k8s/platform-e2e" >"$work/redeploy.log" 2>&1 || { tail -20 "$work/redeploy.log" >&2; fail "deploy.sh failed the second time"; }
check "it runs the migrations again, none pending, and the platform keeps answering" "true 200" \
  "$(grep -q 'No migrations are pending' "$work/redeploy.log" && echo true || echo false) $(https api /readyz >/dev/null; status)"

checks_done e2e-platform

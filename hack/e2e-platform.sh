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
# account, an operator approving it, the account deploying and invoking a function in direct mode, inside gVisor
# as production requires (hack/k8s/gvisor-up.sh installs it in the cluster; deploy.sh refuses a sandbox the
# cluster lacks or no node runs), and reading its logs, the backend's token for the cluster's API lasting an
# hour; the operator's e-mail through the cluster's SMTP; the audit log naming the caller's address, not
# the edge's; who reaches whom inside the cluster; and deploy.sh again, which changes nothing.
#   hack/e2e-platform.sh                  (about 15 minutes; removes its cluster and containers on exit)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/k8s/env.sh"
cluster=ff-platform-e2e
prefix=ff-platform-e2e
https_port="${FF_E2E_PLATFORM_HTTPS_PORT:-58443}"
http_port="${FF_E2E_PLATFORM_HTTP_PORT:-58080}"
work="$(mktemp -d)"
export KUBECONFIG="$work/kubeconfig"
cleanup() {
  local status=$?
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
  fi
  k3d cluster delete "$cluster" >/dev/null 2>&1 || true
  rm -f "$FF_KUBE_DIR/$cluster.kubeconfig"
  docker rm -f "$prefix-postgres" "$prefix-s3" "$prefix-mailpit" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
passed=0
fail() { echo "  FAIL $1" >&2; exit 1; }
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else fail "$1 (expected '$2', got '$3')"; fi
}
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
random() { head -c 18 /dev/urandom | base64 | tr -d '/+=\n'; }

echo "== resources"
MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-5000}" "$FF_REPO_ROOT/hack/check-resources.sh"
for port in "$https_port" "$http_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then fail "port $port is taken: set FF_E2E_PLATFORM_HTTPS_PORT and _HTTP_PORT"; fi
done

echo "== images"
docker build -q -t ff-backend:e2e "$FF_REPO_ROOT/BE" >/dev/null
for app in console:FE admin:admin; do
  docker build -q -t "ff-${app%%:*}:e2e" --build-arg VITE_API_URL="https://api.ff.test:$https_port" \
    --build-arg VITE_OIDC_AUTHORITY="https://login.ff.test:$https_port/realms/ff" "$FF_REPO_ROOT/${app#*:}" >/dev/null
done
docker build -q -t ff-edge:e2e "$FF_REPO_ROOT/deploy/edge" >/dev/null
docker image inspect ff-runtime-nodejs:24-v3 >/dev/null 2>&1 || docker build -q -t ff-runtime-nodejs:24-v3 "$FF_REPO_ROOT/runtimes/nodejs" >/dev/null
echo "  ff-backend, ff-console, ff-admin and ff-edge built, tagged e2e"

echo "== a cluster of its own"
api_port="$(free_port)"
k3d cluster create "$cluster" --image "$FF_K3S_IMAGE" --servers 1 --agents 0 --no-lb \
  --api-port "127.0.0.1:$api_port" --servers-memory 3g \
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
k3d image import -c "$cluster" ff-backend:e2e ff-console:e2e ff-admin:e2e ff-edge:e2e ff-runtime-nodejs:24-v3 >/dev/null 2>&1
echo "  $cluster: k3s ${FF_K3S_IMAGE#*:}, the images imported"

echo "== outside the cluster: PostgreSQL, S3, Mailpit"
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

echo "== deploy/k8s: base, logging, then the platform with deploy.sh"
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/base" >/dev/null
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$work/delete-key"
kubectl -n ff-system create secret generic victoria-logs-delete-key --from-file=key="$work/delete-key" >/dev/null
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/logging" >/dev/null
# The keys that encrypt functions' variables and secrets at rest: one, made for this run.
echo "e2e:$(head -c 32 /dev/urandom | base64)" >"$work/encryption-keys"
kubectl -n ff-system create secret generic ff-encryption-keys --from-file=keys="$work/encryption-keys" >/dev/null
kubectl -n ff-system create secret generic ff-backend --from-literal=DB_PASSWORD="$ff_db" \
  --from-literal=MINIO_ACCESS_KEY="$s3_key" --from-literal=MINIO_SECRET_KEY="$s3_secret" \
  --from-literal=FF_SMTP_URL=smtp://ff-test-smtp.ff-system.svc.cluster.local:1025 >/dev/null
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
check "deploy.sh: the sandbox and a node for it, the migrations first, each run, then every rollout" "true true true" \
  "$(grep -q '^functions run in the RuntimeClass gvisor, on 1 node(s)$' "$work/deploy.log" && echo true || echo false) $(grep -q 'has been executed successfully' "$work/deploy.log" && echo true || echo false) $(grep -q '^platform deployed$' "$work/deploy.log" && echo true || echo false)"
grep -E 'attempt\(s\) failed' "$work/deploy.log" | sed 's/^/  note: /' || true
# The backend's token for the cluster's API is asked for an hour (deploy/k8s/platform/10-backend.yaml): the one
# Kubernetes mounts by default is valid for a year. Read in its pod, from the file the backend reads.
lifetime="$(kubectl -n ff-system exec deploy/ff-backend -- node -e "
const token = require('fs').readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
console.log(claims.exp - claims.iat)")"
check "the backend's token for the cluster's API, read in its pod, lasts an hour" 3600 "$lifetime"

echo "== the edge"
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
# The new pod listens before the node's forwarding to it is in place: until then, connections are reset.
for _ in $(seq 1 60); do
  curl -s -o /dev/null --cacert "$work/root.crt" "${resolve[@]}" "https://admin.ff.test:$https_port/" && break
  sleep 1
done
https admin / >/dev/null
check "once the operator's address ($client_ip) is allowed, the admin app answers" "200 true" \
  "$(status) $(grep -q '<div id="root">' "$work/body" && echo true || echo false)"

echo "== a customer's path, through the edge"
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

echo "== who reaches whom inside the cluster"
kubectl create namespace e2e-probe >/dev/null
kubectl -n e2e-probe run probe --image=ff-runtime-nodejs:24-v3 --image-pull-policy=Never --restart=Never --command -- node -e '
const net = require("node:net");
const targets = { edge: ["ff-edge.ff-edge.svc", 443], backend: ["ff-backend.ff-system.svc", 80], keycloak: ["keycloak.ff-system.svc", 8080],
  console: ["ff-console.ff-system.svc", 80], function: [process.argv[1], 8080] };
Promise.all(Object.entries(targets).map(([name, [host, port]]) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (state) => { socket.destroy(); resolve(name + "=" + state); };
  socket.setTimeout(3000, () => done("refused"));
  socket.once("connect", () => done("open"));
  socket.once("error", () => done("refused"));
}))).then((states) => console.log(states.join(" ")));' "fn-$fn.ff-t-$(printf %s "$account" | sha256sum | cut -c1-12).svc" >/dev/null
kubectl -n e2e-probe wait --for=jsonpath='{.status.phase}'=Succeeded pod/probe --timeout=120s >/dev/null || true
check "an ordinary pod reaches the edge, and neither the backend, Keycloak, the console nor a function" \
  "edge=open backend=refused keycloak=refused console=refused function=refused" "$(kubectl -n e2e-probe logs probe | tail -1)"

echo "== deploy.sh again"
"$FF_REPO_ROOT/deploy/k8s/platform/deploy.sh" "$FF_REPO_ROOT/hack/k8s/platform-e2e" >"$work/redeploy.log" 2>&1 || { tail -20 "$work/redeploy.log" >&2; fail "deploy.sh failed the second time"; }
check "it runs the migrations again, none pending, and the platform keeps answering" "true 200" \
  "$(grep -q 'No migrations are pending' "$work/redeploy.log" && echo true || echo false) $(https api /readyz >/dev/null; status)"

echo "e2e-platform: $passed checks passed"

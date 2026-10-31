#!/usr/bin/env bash
# Verifies the ff-controller identity on the dev cluster:
#   1. RBAC grants exactly what the backend needs (kubectl auth can-i, both ways);
#   2. the production manifests (deploy/k8s/base) grant no Service proxy: the
#      dev overlay's binding is removed for those checks, then restored;
#   3. the ff-controller-scope admission policy confines writes and proxy calls
#      to managed ff-t-* namespaces (real requests made with the minted token).
# Exits non-zero on the first summary with failures. Cleans up after itself.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
source "$FF_REPO_ROOT/hack/lib/checks.sh"

sa="system:serviceaccount:ff-system:ff-controller"
can() { kubectl auth can-i "$@" --as="$sa" 2>/dev/null || true; }
as_sa() { kubectl --kubeconfig="$FF_SA_KUBECONFIG" "$@"; }
# "allowed" if the command succeeds, "denied" if the policy rejected it.
outcome() {
  local out
  if out="$("$@" 2>&1)"; then echo allowed; elif grep -q "ff-controller may only manage" <<<"$out"; then echo denied; else echo "error: $out"; fi
}
# "forbidden" when RBAC refuses the request itself, as for any read of a Secret.
forbidden() {
  local out
  if out="$("$@" 2>&1)"; then echo "allowed"; elif grep -q "forbidden" <<<"$out"; then echo forbidden; else echo "error: $out"; fi
}
# For calls that fail further on anyway (a Service without pods): did the policy let them through?
policy() {
  if "$@" 2>&1 | grep -q "ff-controller may only manage"; then echo denied; else echo "passed the policy"; fi
}
# can-i until it answers $1 (RBAC changes take a moment to reach the authorizer).
can_until() {
  local want="$1" got
  shift
  for _ in $(seq 1 20); do
    got="$(can "$@")"
    [ "$got" = "$want" ] && break
    sleep 0.5
  done
  echo "$got"
}
cleanup() {
  kubectl delete namespace ff-t-rbactest ff-t-rogue rogue-ns --ignore-not-found --wait=false >/dev/null 2>&1
  kubectl -n default delete configmap ff-vap-test --ignore-not-found >/dev/null 2>&1
  kubectl -n default delete secret ff-vap-test --ignore-not-found >/dev/null 2>&1
  kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/dev" >/dev/null 2>&1 # restores the dev overlay's binding
}
on_exit cleanup
cleanup
# A run just before left its namespaces terminating: content can't go in one until it is gone.
kubectl wait --for=delete namespace/ff-t-rbactest namespace/ff-t-rogue namespace/rogue-ns --timeout=120s >/dev/null 2>&1 || true

echo "cluster:"
check "node is Ready" True "$(kubectl get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')"
check "token authenticates as $sa" "$sa" "$(as_sa auth whoami -o jsonpath='{.status.userInfo.username}' 2>/dev/null)"

echo "RBAC grants (kubectl auth can-i --as $sa):"
check "create deployments in a tenant namespace" yes "$(can create deployments -n ff-t-x)"
check "patch deployments/scale" yes "$(can patch deployments --subresource=scale -n ff-t-x)"
check "deletecollection configmaps" yes "$(can deletecollection configmaps -n ff-t-x)"
check "create networkpolicies" yes "$(can create networkpolicies.networking.k8s.io -n ff-t-x)"
check "create services/proxy (dev overlay: the invoke path outside the cluster)" yes "$(can create services --subresource=proxy -n ff-t-x)"
check "list deployments in every namespace at once (capacity samples)" yes "$(can list deployments.apps --all-namespaces)"
check "create namespaces" yes "$(can create namespaces)"
check "create, patch and delete secrets in a tenant namespace: functions' environments" "yes yes yes" \
  "$(can create secrets -n ff-t-x) $(can patch secrets -n ff-t-x) $(can delete secrets -n ff-t-x)"

echo "RBAC denials:"
check "get secrets" no "$(can get secrets -n ff-t-x)"
check "list or watch secrets in a tenant namespace" "no no" "$(can list secrets -n ff-t-x) $(can watch secrets -n ff-t-x)"
check "list secrets in every namespace at once" no "$(can list secrets --all-namespaces)"
check "deletecollection secrets: one by one, by name" no "$(can deletecollection secrets -n ff-t-x)"
check "create pods directly" no "$(can create pods -n ff-t-x)"
check "pods/exec" no "$(can create pods --subresource=exec -n ff-t-x)"
check "create clusterroles" no "$(can create clusterroles.rbac.authorization.k8s.io)"
check "create rolebindings" no "$(can create rolebindings.rbac.authorization.k8s.io -n ff-t-x)"
check "delete nodes" no "$(can delete nodes)"
check "impersonate users" no "$(can impersonate users)"
check "get pods/log: logs and diagnostics read the log store (P-43)" no "$(can get pods --subresource=log -n ff-t-x)"

echo "Production manifests (deploy/k8s/base, without the dev overlay's binding):"
check "the base ClusterRole lists no services/proxy" 0 \
  "$(kubectl kustomize "$FF_REPO_ROOT/deploy/k8s/base" | awk '/^kind: ClusterRole$/ { role = 1 } /^---/ { role = 0 } role' | grep -c 'services/proxy')"
kubectl delete clusterrolebinding ff-controller-dev-proxy >/dev/null
check "no Service proxy in a tenant namespace" no "$(can_until no create services --subresource=proxy -n ff-t-x)"
check "no Service proxy anywhere else" no "$(can_until no get services --subresource=proxy -n default)"
kubectl apply -k "$FF_REPO_ROOT/deploy/k8s/dev" >/dev/null
check "the dev overlay grants it again" yes "$(can_until yes create services --subresource=proxy -n ff-t-x)"

echo "Admission policy (requests with the minted token):"
check "configmap in 'default' is denied" denied \
  "$(outcome as_sa -n default create configmap ff-vap-test --from-literal=a=b)"
check "configmap in 'kube-system' is denied" denied \
  "$(outcome as_sa -n kube-system create configmap ff-vap-test --from-literal=a=b)"
check "unlabelled ff-t-rogue namespace is denied" denied \
  "$(outcome as_sa create namespace ff-t-rogue)"
check "labelled namespace without the ff-t- prefix is denied" denied \
  "$(outcome as_sa apply -f - <<<'{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"rogue-ns","labels":{"app.kubernetes.io/managed-by":"ff-controller"}}}')"
check "labelled ff-t-rbactest namespace is allowed" allowed \
  "$(outcome as_sa apply -f - <<<'{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"ff-t-rbactest","labels":{"app.kubernetes.io/managed-by":"ff-controller"}}}')"
check "configmap inside the managed namespace is allowed" allowed \
  "$(outcome as_sa -n ff-t-rbactest create configmap ff-vap-test --from-literal=a=b)"
check "secret in 'default' is denied" denied \
  "$(outcome as_sa -n default create secret generic ff-vap-test --from-literal=a=b)"
check "secret in 'ff-system', where the platform's credentials are, is denied" denied \
  "$(outcome as_sa -n ff-system apply --server-side --field-manager=ff-controller -f - <<<'{"apiVersion":"v1","kind":"Secret","metadata":{"name":"ff-vap-test"},"stringData":{"a":"b"}}')"
check "secret applied in the managed namespace, as the backend writes a function's environment, is allowed" allowed \
  "$(outcome as_sa -n ff-t-rbactest apply --server-side --field-manager=ff-controller -f - <<<'{"apiVersion":"v1","kind":"Secret","metadata":{"name":"ff-vap-test"},"stringData":{"a":"b"}}')"
check "reading it back is forbidden, even in the managed namespace" forbidden \
  "$(forbidden as_sa -n ff-t-rbactest get secret ff-vap-test)"
check "deleting it by name is allowed" allowed \
  "$(outcome as_sa -n ff-t-rbactest delete secret ff-vap-test)"
check "removing the managed-by label is denied" denied \
  "$(outcome as_sa label namespace ff-t-rbactest app.kubernetes.io/managed-by-)"
as_sa -n ff-t-rbactest create service clusterip ff-vap-test --tcp=8080:8080 >/dev/null 2>&1
check "proxy to a Service in the managed namespace passes the policy" "passed the policy" \
  "$(policy as_sa get --raw /api/v1/namespaces/ff-t-rbactest/services/ff-vap-test:8080/proxy/)"
check "proxy to a Service outside the tenant namespaces is denied" denied \
  "$(outcome as_sa get --raw /api/v1/namespaces/default/services/kubernetes:https/proxy/version)"
check "proxy to the log store's Service passes the policy (P-43)" "passed the policy" \
  "$(policy as_sa get --raw /api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/health)"
check "proxy to the log store by another port is denied" denied \
  "$(outcome as_sa get --raw /api/v1/namespaces/ff-system/services/victoria-logs:9429/proxy/health)"
check "proxy to another Service in ff-system is denied" denied \
  "$(outcome as_sa get --raw /api/v1/namespaces/ff-system/services/kube-dns:9428/proxy/health)"
check "deleting the managed namespace is allowed" allowed \
  "$(outcome as_sa delete namespace ff-t-rbactest --wait=false)"
check "users other than ff-controller are unaffected" allowed \
  "$(outcome kubectl -n default create configmap ff-vap-test --from-literal=a=b)"

checks_done rbac/admission

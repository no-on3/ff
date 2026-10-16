#!/usr/bin/env bash
# Verifies the ff-controller identity on the dev cluster:
#   1. RBAC grants exactly what the backend needs (kubectl auth can-i, both ways);
#   2. the ff-controller-scope admission policy confines writes to managed
#      ff-t-* namespaces (real requests made with the minted token).
# Exits non-zero on the first summary with failures. Cleans up after itself.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

sa="system:serviceaccount:ff-system:ff-controller"
passed=0
failed=0

check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
    passed=$((passed + 1))
  else
    echo "  FAIL $1 (expected '$2', got '$3')"
    failed=$((failed + 1))
  fi
}
can() { kubectl auth can-i "$@" --as="$sa" 2>/dev/null || true; }
as_sa() { kubectl --kubeconfig="$FF_SA_KUBECONFIG" "$@"; }
# "allowed" if the command succeeds, "denied" if the policy rejected it.
outcome() {
  local out
  if out="$("$@" 2>&1)"; then echo allowed; elif grep -q "ff-controller may only manage" <<<"$out"; then echo denied; else echo "error: $out"; fi
}
cleanup() {
  kubectl delete namespace ff-t-rbactest ff-t-rogue rogue-ns --ignore-not-found --wait=false >/dev/null 2>&1
  kubectl -n default delete configmap ff-vap-test --ignore-not-found >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

echo "cluster:"
check "node is Ready" True "$(kubectl get nodes -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}')"
check "token authenticates as $sa" "$sa" "$(as_sa auth whoami -o jsonpath='{.status.userInfo.username}' 2>/dev/null)"

echo "RBAC grants (kubectl auth can-i --as $sa):"
check "create deployments in a tenant namespace" yes "$(can create deployments -n ff-t-x)"
check "patch deployments/scale" yes "$(can patch deployments --subresource=scale -n ff-t-x)"
check "deletecollection configmaps" yes "$(can deletecollection configmaps -n ff-t-x)"
check "create networkpolicies" yes "$(can create networkpolicies.networking.k8s.io -n ff-t-x)"
check "create services/proxy (dev invoke path)" yes "$(can create services --subresource=proxy -n ff-t-x)"
check "get pods/log (diagnostics)" yes "$(can get pods --subresource=log -n ff-t-x)"
check "create namespaces" yes "$(can create namespaces)"

echo "RBAC denials:"
check "get secrets" no "$(can get secrets -n ff-t-x)"
check "create pods directly" no "$(can create pods -n ff-t-x)"
check "pods/exec" no "$(can create pods --subresource=exec -n ff-t-x)"
check "create clusterroles" no "$(can create clusterroles.rbac.authorization.k8s.io)"
check "create rolebindings" no "$(can create rolebindings.rbac.authorization.k8s.io -n ff-t-x)"
check "delete nodes" no "$(can delete nodes)"
check "impersonate users" no "$(can impersonate users)"

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
check "removing the managed-by label is denied" denied \
  "$(outcome as_sa label namespace ff-t-rbactest app.kubernetes.io/managed-by-)"
check "deleting the managed namespace is allowed" allowed \
  "$(outcome as_sa delete namespace ff-t-rbactest --wait=false)"
check "users other than ff-controller are unaffected" allowed \
  "$(outcome kubectl -n default create configmap ff-vap-test --from-literal=a=b)"

echo "rbac/admission: $passed passed, $failed failed"
[ "$failed" -eq 0 ]

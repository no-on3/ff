#!/usr/bin/env bash
# Deploys FF's platform from a kustomization: deploy/k8s/platform, or an overlay of it with FF's own values.
# First the migrations, from the new backend image, waited for: the backend refuses to start on a schema with
# migrations pending. Then everything else, waited for. Needs base/ and logging/ applied, the Secrets, the
# sandbox functions run in, with a node to run it, and the nodes told where code images are (deploy/k8s/README.md,
# "Platform").
#   deploy/k8s/platform/deploy.sh <kustomization directory>
set -euo pipefail
dir="${1:?usage: $0 <kustomization directory>}"

echo "== the sandbox"
# The backend's K8S_RUNTIME_CLASS: without its RuntimeClass, or a node its nodeSelector picks, every function
# would wait for a pod that never starts.
class="$(kubectl kustomize "$dir" | sed -n 's/^  K8S_RUNTIME_CLASS: *//p' | tr -d '"' | head -1)"
if [ -n "$class" ]; then
  kubectl get runtimeclass "$class" >/dev/null 2>&1 || {
    echo "the backend runs functions in the RuntimeClass $class, which the cluster lacks: install gVisor on the nodes," >&2
    echo "label them, and apply deploy/k8s/optional/runtimeclass-gvisor.yaml (deploy/k8s/README.md, \"Platform\")" >&2
    exit 1
  }
  selector="$(kubectl get runtimeclass "$class" -o go-template='{{range $k, $v := .scheduling.nodeSelector}}{{$k}}={{$v}},{{end}}')"
  nodes="$(kubectl get nodes -l "${selector%,}" -o name | wc -l)"
  [ "$nodes" -gt 0 ] || { echo "no node has the label ${selector%,} that the RuntimeClass $class schedules on" >&2; exit 1; }
  echo "functions run in the RuntimeClass $class, on $nodes node(s)"
else
  echo "functions run without a sandbox (K8S_ALLOW_UNSANDBOXED): never with customers' code" >&2
fi

echo "== function URLs"
# The edge's function domain must be the host of the backend's FF_FUNCTION_URL_BASE, or the addresses the API
# gives would reach nothing; a wildcard certificate needs the TSIG key that lets the edge write the DNS record.
rendered="$(kubectl kustomize "$dir")"
setting() { sed -n "s/^  $1: *//p" <<<"$rendered" | tr -d '"' | head -1; }
base="$(setting FF_FUNCTION_URL_BASE)"
domain="$(setting FF_FUNCTION_URL_DOMAIN)"
tls="$(setting FF_FUNCTION_URL_TLS)"
base_host="${base#*://}"
base_host="${base_host%%[:/]*}"
if [ "$base_host" != "$domain" ]; then
  echo "the edge's FF_FUNCTION_URL_DOMAIN ($domain) must be the host of the backend's FF_FUNCTION_URL_BASE ($base)" >&2
  exit 1
fi
case "$tls" in
  wildcard)
    kubectl -n ff-edge get secret ff-edge-dns -o jsonpath='{.data.FF_DNS_TSIG_KEY}' 2>/dev/null | grep -q . || {
      echo "FF_FUNCTION_URL_TLS=wildcard needs the Secret ff-edge-dns with FF_DNS_TSIG_KEY, the TSIG key the edge signs" >&2
      echo "the DNS updates with (deploy/k8s/README.md, \"Function URLs\"); or choose on-demand" >&2
      exit 1
    }
    echo "function URLs under $domain, with one certificate for *.$domain, through DNS"
    ;;
  on-demand) echo "function URLs under $domain, with a certificate per host, on demand: Let's Encrypt gives 50 a week" ;;
  *)
    echo "the edge's FF_FUNCTION_URL_TLS must be wildcard or on-demand, not '$tls'" >&2
    exit 1
    ;;
esac

echo "== buckets' S3 front door"
# The edge's storage host must be the host of the backend's FF_STORAGE_BASE, which customers give AWS's SDKs and CLI,
# or their requests would reach nothing; a wildcard certificate needs the same TSIG key as function URLs'.
storage_base="$(setting FF_STORAGE_BASE)"
storage_host="$(setting FF_STORAGE_HOST)"
storage_tls="$(setting FF_STORAGE_TLS)"
storage_base_host="${storage_base#*://}"
storage_base_host="${storage_base_host%%[:/]*}"
if [ "$storage_base_host" != "$storage_host" ]; then
  echo "the edge's FF_STORAGE_HOST ($storage_host) must be the host of the backend's FF_STORAGE_BASE ($storage_base)" >&2
  exit 1
fi
case "$storage_tls" in
  wildcard)
    kubectl -n ff-edge get secret ff-edge-dns -o jsonpath='{.data.FF_DNS_TSIG_KEY}' 2>/dev/null | grep -q . || {
      echo "FF_STORAGE_TLS=wildcard needs the Secret ff-edge-dns with FF_DNS_TSIG_KEY, as FF_FUNCTION_URL_TLS=wildcard does; or choose on-demand" >&2
      exit 1
    }
    echo "buckets at $storage_host and under it, with one certificate for both, through DNS"
    ;;
  on-demand) echo "buckets at $storage_host and under it, with a certificate per host, on demand, out of the same 50 a week" ;;
  *)
    echo "the edge's FF_STORAGE_TLS must be wildcard or on-demand, not '$storage_tls'" >&2
    exit 1
    ;;
esac

echo "== the code registry"
# Packages' code images: the registry's two users, from the Secret ff-code-registry, and the backend's password for
# its own (deploy/k8s/README.md, "The code registry").
users="$(kubectl -n ff-system get secret ff-code-registry -o jsonpath='{.data.htpasswd}' 2>/dev/null | base64 -d | cut -d: -f1 | sort | xargs)"
if [ "$users" != "ff-backend ff-node" ]; then
  echo "the Secret ff-code-registry must hold htpasswd, with the users ff-backend and ff-node, and no other" >&2
  echo "(deploy/k8s/README.md, \"The code registry\")" >&2
  exit 1
fi
kubectl -n ff-system get secret ff-backend -o jsonpath='{.data.FF_CODE_REGISTRY_PASSWORD}' 2>/dev/null | grep -q . || {
  echo "the Secret ff-backend must hold FF_CODE_REGISTRY_PASSWORD, ff-backend's password in the code registry" >&2
  exit 1
}
echo "the registry's users: ff-backend pushes, ff-node pulls"

echo "== migrations"
# A Job's template never changes: the last one goes first.
kubectl -n ff-system delete job ff-migrations --ignore-not-found --wait=true >/dev/null
kubectl apply -k "$dir" -l ff.dev/deploy-step=migrations
for _ in $(seq 1 180); do
  state="$(kubectl -n ff-system get job ff-migrations -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type} {end}')"
  case "$state" in
    *Complete*) break ;;
    *Failed*)
      kubectl -n ff-system logs job/ff-migrations --tail=30 >&2 || true
      echo "the migrations failed: nothing else was deployed" >&2
      exit 1
      ;;
  esac
  sleep 5
done
[[ $state == *Complete* ]] || { echo "the migrations did not finish within 15 minutes" >&2; exit 1; }
# What they did, from every attempt: a failed one (the database not reachable yet, say) is tried again.
kubectl -n ff-system logs -l job-name=ff-migrations --tail=-1 | grep -E 'has been executed successfully|No migrations are pending' || true
failed="$(kubectl -n ff-system get job ff-migrations -o jsonpath='{.status.failed}')"
[ -z "$failed" ] || echo "($failed attempt(s) failed before: see kubectl -n ff-system logs -l job-name=ff-migrations)"

echo "== the platform"
kubectl apply -k "$dir"
for deployment in ff-code-registry ff-backend keycloak ff-console ff-admin; do
  kubectl -n ff-system rollout status "deployment/$deployment" --timeout=600s
done
kubectl -n ff-edge rollout status deployment/ff-edge --timeout=300s
echo "platform deployed"
address="$(kubectl -n ff-system get service ff-code-registry -o jsonpath='{.spec.clusterIP}')"
echo "functions' code images: registry.ff.internal, which each node's containerd maps to http://$address:5000, as ff-node"

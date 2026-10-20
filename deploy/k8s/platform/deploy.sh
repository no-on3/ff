#!/usr/bin/env bash
# Deploys FF's platform from a kustomization: deploy/k8s/platform, or an overlay of it with FF's own values.
# First the migrations, from the new backend image, waited for: the backend refuses to start on a schema with
# migrations pending. Then everything else, waited for. Needs base/ and logging/ applied, and the Secrets
# (deploy/k8s/README.md, "Platform").
#   deploy/k8s/platform/deploy.sh <kustomization directory>
set -euo pipefail
dir="${1:?usage: $0 <kustomization directory>}"

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
for deployment in ff-backend keycloak ff-console ff-admin; do
  kubectl -n ff-system rollout status "deployment/$deployment" --timeout=600s
done
kubectl -n ff-edge rollout status deployment/ff-edge --timeout=300s
echo "platform deployed"

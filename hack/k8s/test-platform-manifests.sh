#!/usr/bin/env bash
# The platform's manifests (deploy/k8s/platform, and the legal records' mirror, deploy/k8s/backup), checked
# without deploying them, in about a minute:
#   - every pod as Pod Security "restricted" wants it and more: non-root by number, no capability, no privilege
#     escalation, the runtime's seccomp profile, a read-only root (Keycloak's alone may write, named here),
#     memory limits, probes, no API token but the backend's;
#   - every workload behind a NetworkPolicy, ff-system denying by default, and every Service selecting pods;
#   - the backend's settings (backend.env, with the Secret's keys) read by the backend's own configuration:
#     accepted, but for the seller's and the bank's details, which an overlay must give;
#   - the production realm up to date with the development realm;
#   - the edge's Caddyfile, with its settings, valid for Caddy, in the edge's image;
#   - all of it valid for the dev cluster's API, no field unknown (a server dry run, which writes nothing).
#   hack/k8s/test-platform-manifests.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
platform="$FF_REPO_ROOT/deploy/k8s/platform"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
passed=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "  ok   $1"; passed=$((passed + 1)); else echo "  FAIL $1 (expected '$2', got '$3')"; exit 1; fi
}
# The platform, and the legal records' mirror (deploy/k8s/backup), which runs beside it.
{ kubectl kustomize "$platform"; echo ---; kubectl kustomize "$FF_REPO_ROOT/deploy/k8s/backup"; } >"$work/platform.yaml"

echo "== the pods"
python3 - "$work/platform.yaml" >"$work/pods.txt" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
# Keycloak's start builds its configuration into its own directories (deploy/k8s/platform/40-keycloak.yaml).
WRITABLE_ROOT = {'keycloak'}
# The backend manages the tenants' namespaces with its ServiceAccount's token; nothing else needs one.
API_TOKEN = {'ff-backend'}
problems = []
for doc in docs:
    if doc['kind'] not in ('Deployment', 'Job', 'CronJob'):
        continue
    name = doc['metadata']['name']
    pod = (doc['spec']['jobTemplate']['spec'] if doc['kind'] == 'CronJob' else doc['spec'])['template']['spec']
    context = pod.get('securityContext', {})
    if context.get('runAsNonRoot') is not True or not isinstance(context.get('runAsUser'), int) or context['runAsUser'] == 0:
        problems.append(f'{name}: not non-root by number')
    if context.get('seccompProfile', {}).get('type') != 'RuntimeDefault':
        problems.append(f'{name}: no RuntimeDefault seccomp profile')
    if (pod.get('automountServiceAccountToken', True) is not False) != (name in API_TOKEN):
        problems.append(f'{name}: an API token where none is needed, or none where one is')
    for container in pod['containers']:
        where = f"{name}/{container['name']}"
        security = container.get('securityContext', {})
        if security.get('allowPrivilegeEscalation') is not False:
            problems.append(f'{where}: privilege escalation allowed')
        if security.get('capabilities', {}).get('drop') != ['ALL'] or security.get('capabilities', {}).get('add'):
            problems.append(f'{where}: capabilities not all dropped')
        if (security.get('readOnlyRootFilesystem') is True) == (name in WRITABLE_ROOT):
            problems.append(f'{where}: read-only root not as listed')
        if 'memory' not in container.get('resources', {}).get('limits', {}) or 'memory' not in container.get('resources', {}).get('requests', {}):
            problems.append(f'{where}: no memory request or limit')
        if doc['kind'] == 'Deployment' and not (container.get('readinessProbe') and container.get('livenessProbe')):
            problems.append(f'{where}: no readiness or liveness probe')
        image = container['image']
        if ':' not in image.split('/')[-1] or image.endswith(':latest') and not image.startswith('ff-'):
            problems.append(f'{where}: image {image} not pinned')
print(len([d for d in docs if d['kind'] in ('Deployment', 'Job', 'CronJob')]))
for problem in problems: print(problem)
PY
check "every workload hardened: non-root, no capability, no escalation, seccomp, read-only root but Keycloak's, limits, probes" \
  "7" "$(cat "$work/pods.txt")"

echo "== who reaches whom"
python3 - "$work/platform.yaml" >"$work/policies.txt" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
policies = [d for d in docs if d['kind'] == 'NetworkPolicy']
def selects(selector, labels):
    if 'matchLabels' in selector and any(labels.get(k) != v for k, v in selector['matchLabels'].items()):
        return False
    for expression in selector.get('matchExpressions', []):
        if expression['operator'] == 'In' and labels.get(expression['key']) not in expression['values']:
            return False
    return True
problems = []
for doc in docs:
    if doc['kind'] != 'Deployment':
        continue
    labels, namespace = doc['spec']['template']['metadata']['labels'], doc['metadata']['namespace']
    own = [p for p in policies if p['metadata']['namespace'] == namespace and p['spec']['podSelector'] and selects(p['spec']['podSelector'], labels)]
    if not own:
        problems.append(f"{doc['metadata']['name']}: no NetworkPolicy of its own")
if not any(p['metadata']['name'] == 'default-deny-ingress' and p['metadata']['namespace'] == 'ff-system' and p['spec']['podSelector'] == {} and 'ingress' not in p['spec'] for p in policies):
    problems.append('ff-system: no default deny')
for service in (d for d in docs if d['kind'] == 'Service'):
    if not any(d['kind'] == 'Deployment' and d['metadata']['namespace'] == service['metadata']['namespace'] and selects({'matchLabels': service['spec']['selector']}, d['spec']['template']['metadata']['labels']) for d in docs):
        problems.append(f"Service {service['metadata']['name']}: selects no pod")
print('\n'.join(problems) or 'none')
PY
check "every workload behind a NetworkPolicy of its own, ff-system denying the rest, every Service selecting pods" none "$(cat "$work/policies.txt")"

echo "== the settings"
# The backend's own configuration reads backend.env with the Secret's keys: accepted, but for what an overlay must give.
(cd "$FF_REPO_ROOT/BE" && [ -f dist/config/configuration.js ] || npm run build >/dev/null)
problems="$(cd "$FF_REPO_ROOT/BE" && node -e "
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync('$platform/backend.env', 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
Object.assign(env, { DB_PASSWORD: 'secret', MINIO_ACCESS_KEY: 'key', MINIO_SECRET_KEY: 'secret', FF_SMTP_URL: 'smtp://user:pass@smtp.example.tn:587' });
try { require('./dist/config/configuration').default(env); console.log('accepted'); } catch (e) { console.log((e.problems || [e.message]).map((p) => p.split(' ')[0]).join(' ')); }
")"
check "the backend's settings, with the Secret's, accepted but for the seller and the bank, which an overlay gives" \
  "FF_SELLER_NAME FF_SELLER_TAX_ID FF_SELLER_ADDRESS FF_BANK_NAME FF_BANK_IBAN" "$problems"
check "the production realm made from the development realm, up to date" 0 \
  "$("$FF_REPO_ROOT/deploy/keycloak/production-realm.py" --check >/dev/null 2>&1; echo $?)"

echo "== the edge"
docker build -q -t ff-edge:test "$FF_REPO_ROOT/deploy/edge" >/dev/null
check "its image: Caddy 2.11.7, as the numeric user 65532" "v2.11.7 65532:65532" \
  "$(docker run --rm ff-edge:test caddy version | cut -d' ' -f1) $(docker image inspect ff-edge:test --format '{{.Config.User}}')"
check "its Caddyfile, with its settings, valid for Caddy" 0 \
  "$(docker run --rm --read-only --tmpfs /tmp --tmpfs /data --cap-drop ALL --security-opt no-new-privileges --env-file "$platform/edge.env" \
      -v "$platform/edge/Caddyfile:/etc/caddy/Caddyfile:ro" ff-edge:test caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$work/validate.log" 2>&1; echo $?)"

echo "== the cluster's API"
# A server dry run writes nothing, and refuses an unknown field. The dev cluster has no ff-edge: its objects are
# tried in ff-system, which it has.
python3 - "$work/platform.yaml" "$work/validate.yaml" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d['kind'] != 'Namespace']
for doc in docs:
    if doc['metadata'].get('namespace') == 'ff-edge':
        doc['metadata']['namespace'] = 'ff-system'
yaml.safe_dump_all(docs, open(sys.argv[2], 'w'))
PY
check "every object valid for the API's schemas, no field unknown (a server dry run)" 0 \
  "$(kubectl apply --dry-run=server --validate=strict -f "$work/validate.yaml" >"$work/dry-run.log" 2>&1; echo $?)"
grep -iE 'error|unknown' "$work/dry-run.log" | head -5 || true

echo "platform manifests: $passed checks passed"

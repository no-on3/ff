#!/usr/bin/env bash
# The platform's manifests (deploy/k8s/platform, and the mirror to the second site, deploy/k8s/backup), checked
# without deploying them, in about a minute:
#   - every pod as Pod Security "restricted" wants it and more: non-root by number, no capability, no privilege
#     escalation, the runtime's seccomp profile, a read-only root (Keycloak's alone may write, named here),
#     memory limits, probes, no API token but the backend's, and the backend's asked for an hour, not the year
#     of the token Kubernetes mounts by default; and a Secret only its group may read given to the pod's group;
#   - credentials only in Secrets: none in a ConfigMap, an environment value or a command line, whose
#     contents the backend's token can read across the cluster;
#   - every workload behind a NetworkPolicy, ff-system denying by default, and every Service selecting pods;
#   - the backend's settings (backend.env, with the Secret's keys) read by the backend's own configuration:
#     accepted, but for the seller's and the bank's details, which an overlay must give; its encryption keys
#     mounted from their Secret where its settings look;
#   - the production realm up to date with the development realm;
#   - function URLs: the edge's function domain the backend's, the backend's port for them reached by the edge alone;
#   - buckets' S3 front door and queues' SQS endpoint: the edge's host for each the backend's, the backend's port for
#     each reached by the edge and tenants' functions alone, functions' fixed address for it, each host sent there;
#   - the edge's Caddyfile, with its settings, valid for Caddy, in the edge's image, both ways to function URLs' and
#     buckets' certificates;
#   - the code registry: Zot's settings valid for its pinned image, where its volume and its users' Secret are
#     mounted, its fixed address and port the backend's settings name, and the backend alone reaching it;
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
# The platform, and the mirror to the second site (deploy/k8s/backup), which runs beside it.
{ kubectl kustomize "$platform"; echo ---; kubectl kustomize "$FF_REPO_ROOT/deploy/k8s/backup"; } >"$work/platform.yaml"

echo "== the pods"
python3 - "$work/platform.yaml" >"$work/pods.txt" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
# Keycloak's start builds its configuration into its own directories (deploy/k8s/platform/40-keycloak.yaml).
WRITABLE_ROOT = {'keycloak'}
# The backend manages the tenants' namespaces with its ServiceAccount's token; nothing else needs one. The token
# Kubernetes mounts by default is valid for a year; the backend's is asked for an hour at most, and renewed.
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
    tokens = [source['serviceAccountToken'] for volume in pod.get('volumes', [])
              for source in volume.get('projected', {}).get('sources', []) if 'serviceAccountToken' in source]
    if pod.get('automountServiceAccountToken', True) is not False:
        problems.append(f'{name}: the API token mounted by default, valid for a year')
    if name not in API_TOKEN and tokens:
        problems.append(f'{name}: an API token it does not need')
    if name in API_TOKEN and (len(tokens) != 1 or not 600 <= tokens[0].get('expirationSeconds', 0) <= 3600):
        problems.append(f'{name}: no API token of an hour at most')
    # A file only its group may read reaches the pod's user through fsGroup alone: else the pod can't read it.
    for volume in pod.get('volumes', []):
        source = volume.get('secret') or volume.get('configMap')
        if source and source.get('defaultMode') is not None and not source['defaultMode'] & 0o004 and context.get('fsGroup') is None:
            problems.append(f"{name}: volume {volume['name']} only its group may read, and no fsGroup gives the pod that group")
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
check "every workload hardened: non-root, no capability, no escalation, seccomp, read-only root but Keycloak's, limits, probes, the backend's API token an hour long and no other, the files it may read readable" \
  "8" "$(cat "$work/pods.txt")"

echo "== credentials"
# The backend's token reads ConfigMaps and pods' specs across the cluster, but no Secret (deploy/k8s/README.md,
# "Cluster-wide reads"): so a credential goes in a Secret, never in what that token can read.
python3 - "$work/platform.yaml" >"$work/credentials.txt" <<'PY'
import json, re, sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
NAME = re.compile(r'PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE|CREDENTIAL|ACCESS_KEY|API_KEY', re.I)
VALUE = re.compile(r'://[^/\s:@]+:[^/\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----')
FIELD = re.compile(r'password|secret|clientSecret|privateKey', re.I)
problems = []
def look(where, value):
    if isinstance(value, str) and VALUE.search(value):
        problems.append(f'{where}: a password in a URL, or a private key')
def fields(where, node):  # a JSON file's own credentials, but for ${...}, filled in from a Secret at start
    if isinstance(node, dict):
        for key, child in node.items():
            if FIELD.fullmatch(key) and isinstance(child, str) and child and not re.fullmatch(r'\$\{\w+\}', child):
                problems.append(f'{where}: {key} written in it')
            fields(where, child)
    elif isinstance(node, list):
        for child in node:
            fields(where, child)
for doc in docs:
    name = doc['metadata']['name']
    if doc['kind'] == 'ConfigMap':
        for key, value in (doc.get('data') or {}).items():
            if NAME.search(key):
                problems.append(f'ConfigMap {name}: {key}')
            look(f'ConfigMap {name}/{key}', value)
            if key.endswith('.json'):
                fields(f'ConfigMap {name}/{key}', json.loads(value))
    if doc['kind'] in ('Deployment', 'Job', 'CronJob'):
        pod = (doc['spec']['jobTemplate']['spec'] if doc['kind'] == 'CronJob' else doc['spec'])['template']['spec']
        for container in pod['containers'] + pod.get('initContainers', []):
            for variable in container.get('env', []):
                if 'value' in variable and NAME.search(variable['name']):
                    problems.append(f"{name}/{container['name']}: {variable['name']} as a value")
                look(f"{name}/{container['name']} {variable['name']}", variable.get('value'))
            for argument in container.get('command', []) + container.get('args', []):
                look(f"{name}/{container['name']}'s command line", argument)
print('\n'.join(problems) or 'none')
PY
check "credentials only in Secrets: none in a ConfigMap, an environment value or a command line" none "$(cat "$work/credentials.txt")"

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
Object.assign(env, { DB_PASSWORD: 'secret', FF_OBJECT_STORE_ACCESS_KEY: 'key', FF_OBJECT_STORE_SECRET_KEY: 'secret', FF_SMTP_URL: 'smtp://user:pass@smtp.example.tn:587', FF_CODE_REGISTRY_PASSWORD: 'secret' });
try { require('./dist/config/configuration').default(env); console.log('accepted'); } catch (e) { console.log((e.problems || [e.message]).map((p) => p.split(' ')[0]).join(' ')); }
")"
check "the backend's settings, with the Secret's, accepted but for the seller and the bank, which an overlay gives" \
  "FF_SELLER_NAME FF_SELLER_TAX_ID FF_SELLER_ADDRESS FF_BANK_NAME FF_BANK_IBAN" "$problems"
check "the production realm made from the development realm, up to date" 0 \
  "$("$FF_REPO_ROOT/deploy/keycloak/production-realm.py" --check >/dev/null 2>&1; echo $?)"

# The keys that seal functions' variables and secrets: the Secret mounted where the backend's settings look, read-only.
keys_file="$(sed -n 's/^FF_ENCRYPTION_KEYS_FILE=//p' "$platform/backend.env")"
check "the backend's encryption keys mounted from their Secret where FF_ENCRYPTION_KEYS_FILE looks, read-only" "$keys_file" \
  "$(python3 - "$work/platform.yaml" <<'PY'
import sys, yaml
backend = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d['kind'] == 'Deployment' and d['metadata']['name'] == 'ff-backend')
pod = backend['spec']['template']['spec']
volume = next(v['name'] for v in pod['volumes'] if v.get('secret', {}).get('secretName') == 'ff-encryption-keys')
mount = next(m for m in pod['containers'][0]['volumeMounts'] if m['name'] == volume)
print(f"{mount['mountPath']}/keys" if mount.get('readOnly') else 'writable')
PY
)"

echo "== function URLs"
# The edge serves the function domain, the host of the addresses the backend gives; it reaches the backend's port
# for them through the Service, as do its questions before a certificate on demand; nothing else reaches that port.
check "the edge's function domain is the host of the backend's FF_FUNCTION_URL_BASE" "fn.example.tn fn.example.tn" \
  "$(sed -n 's/^FF_FUNCTION_URL_DOMAIN=//p' "$platform/edge.env") $(sed -n 's#^FF_FUNCTION_URL_BASE=https://##p' "$platform/backend.env")"
url_port="$(sed -n 's/^FF_FUNCTION_URL_PORT=//p' "$platform/backend.env")"
check "the backend's port for function URLs in its Service, reached by the edge alone" "$url_port function-urls edge-only" \
  "$(python3 - "$work/platform.yaml" "$url_port" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
port = int(sys.argv[2])
named = lambda kind, name: next(d for d in docs if d['kind'] == kind and d['metadata']['name'] == name)
container = next(p for p in named('Deployment', 'ff-backend')['spec']['template']['spec']['containers'][0]['ports'] if p['containerPort'] == port)
service = next(p for p in named('Service', 'ff-backend')['spec']['ports'] if p['targetPort'] == container['name'])
reaching = [rule['from'] for rule in named('NetworkPolicy', 'ff-backend')['spec']['ingress'] if port in [p['port'] for p in rule['ports']]]
edge = len(reaching) == 1 and all(peer.get('podSelector', {}).get('matchLabels', {}).get('app.kubernetes.io/name') == 'ff-edge' for peer in reaching[0])
print(service['port'], container['name'], 'edge-only' if edge else 'open')
PY
)"
check "the edge sends them there, function URLs' hosts and customers' own domains, and asks there before a certificate on demand" \
  "ask http://ff-backend.ff-system.svc.cluster.local:$url_port/tls/allowed 2" \
  "$(grep -oE 'ask http://[^ ]+' "$platform/edge/Caddyfile") $(grep -c "reverse_proxy ff-backend.ff-system.svc.cluster.local:$url_port$" "$platform/edge/Caddyfile")"

echo "== buckets' S3 front door"
# The edge serves the backend's S3 endpoint and each bucket's host under it, on the backend's port for them, which
# nothing else reaches; certificates on demand are asked at function URLs' port, the edge's one address for them all.
check "the edge's storage host is the host of the backend's FF_STORAGE_BASE" "s3.example.tn s3.example.tn" \
  "$(sed -n 's/^FF_STORAGE_HOST=//p' "$platform/edge.env") $(sed -n 's#^FF_STORAGE_BASE=https://##p' "$platform/backend.env")"
storage_port="$(sed -n 's/^FF_STORAGE_PORT=//p' "$platform/backend.env")"
sqs_port="$(sed -n 's/^FF_SQS_PORT=//p' "$platform/backend.env")"
# reached_by <port>: the backend's Service port and container port for it, and who its NetworkPolicy lets in there,
# the edge's pods or tenants' functions; "functions reach more" when functions reach a port other than buckets' and
# queues'.
reached_by() {
  python3 - "$work/platform.yaml" "$1" "$storage_port" "$sqs_port" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
port = int(sys.argv[2])
theirs = {int(sys.argv[3]), int(sys.argv[4])}
named = lambda kind, name: next(d for d in docs if d['kind'] == kind and d['metadata']['name'] == name)
container = next(p for p in named('Deployment', 'ff-backend')['spec']['template']['spec']['containers'][0]['ports'] if p['containerPort'] == port)
service = next(p for p in named('Service', 'ff-backend')['spec']['ports'] if p['targetPort'] == container['name'])
def who(peers):
    if all(peer.get('podSelector', {}).get('matchLabels', {}).get('app.kubernetes.io/name') == 'ff-edge' for peer in peers):
        return 'edge'
    tenants = {'app.kubernetes.io/managed-by': 'ff-controller'}
    functions = {'app.kubernetes.io/name': 'ff-function'}
    if all(peer.get('namespaceSelector', {}).get('matchLabels') == tenants and peer.get('podSelector', {}).get('matchLabels') == functions for peer in peers):
        return 'functions'
    return 'open'
reaching = [who(rule['from']) for rule in named('NetworkPolicy', 'ff-backend')['spec']['ingress'] if port in [p['port'] for p in rule['ports']]]
others = [rule for rule in named('NetworkPolicy', 'ff-backend')['spec']['ingress'] if who(rule['from']) == 'functions' and not {p['port'] for p in rule['ports']} <= theirs]
print(service['port'], container['name'], ','.join(reaching) if not others else 'functions reach more')
PY
}
# ff_storage <port>: the Service ff-storage's fixed address on that port, and the container port it reaches.
ff_storage() {
  python3 - "$work/platform.yaml" "$1" <<'PY'
import sys, yaml
service = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d['kind'] == 'Service' and d['metadata']['name'] == 'ff-storage')
port = next(p for p in service['spec']['ports'] if p['port'] == int(sys.argv[2]))
print(f"{service['spec']['clusterIP']}:{port['port']} {port['targetPort']}")
PY
}
# Functions reach it too, with their own keys, at the fixed address of a Service of its own: the tenants' function
# pods on that port alone, which their NetworkPolicy opens on the backend's pods, as no FF_STORAGE_FUNCTION_CIDRS says.
check "the backend's port for buckets in its Service, reached by the edge and tenants' functions alone" "$storage_port storage edge,functions" \
  "$(reached_by "$storage_port")"
check "functions' address for it: the Service ff-storage's fixed one, on that port, which the backend names to their pods" \
  "10.43.0.251:$storage_port storage http://10.43.0.251:$storage_port none" \
  "$(ff_storage "$storage_port") $(sed -n 's/^FF_STORAGE_FUNCTION_ENDPOINT=//p' "$platform/backend.env") $(grep -q '^FF_STORAGE_FUNCTION_CIDRS=.' "$platform/backend.env" && echo some || echo none)"
check "the edge sends both of its hosts there" "1 1" \
  "$(grep -c '^{\$FF_STORAGE_HOST}, \*\.{\$FF_STORAGE_HOST} {$' "$platform/edge/Caddyfile") $(grep -c "reverse_proxy ff-backend.ff-system.svc.cluster.local:$storage_port$" "$platform/edge/Caddyfile")"

echo "== queues' SQS endpoint"
# The edge serves the backend's SQS endpoint, one host, on the backend's port for it; functions reach that port at
# ff-storage's address too, where the queues' URLs they are answered begin.
check "the edge's SQS host is the host of the backend's FF_SQS_BASE" "sqs.example.tn sqs.example.tn" \
  "$(sed -n 's/^FF_SQS_HOST=//p' "$platform/edge.env") $(sed -n 's#^FF_SQS_BASE=https://##p' "$platform/backend.env")"
check "the backend's port for queues in its Service, reached by the edge and tenants' functions alone" "$sqs_port sqs edge,functions" \
  "$(reached_by "$sqs_port")"
check "functions' address for it: the Service ff-storage's fixed one, on that port, which the backend names to their pods" \
  "10.43.0.251:$sqs_port sqs http://10.43.0.251:$sqs_port none" \
  "$(ff_storage "$sqs_port") $(sed -n 's/^FF_SQS_FUNCTION_ENDPOINT=//p' "$platform/backend.env") $(grep -q '^FF_SQS_FUNCTION_CIDRS=.' "$platform/backend.env" && echo some || echo none)"
check "the edge sends its host there" "1 1" \
  "$(grep -c '^{\$FF_SQS_HOST} {$' "$platform/edge/Caddyfile") $(grep -c "reverse_proxy ff-backend.ff-system.svc.cluster.local:$sqs_port$" "$platform/edge/Caddyfile")"

echo "== the edge"
docker build -q -t ff-edge:test "$FF_REPO_ROOT/deploy/edge" >/dev/null
check "its image: Caddy 2.11.7 with the RFC 2136 DNS module, as the numeric user 65532" "v2.11.7 1 65532:65532" \
  "$(docker run --rm ff-edge:test caddy version | cut -d' ' -f1) $(docker run --rm ff-edge:test caddy list-modules | grep -c '^dns.providers.rfc2136$') $(docker image inspect ff-edge:test --format '{{.Config.User}}')"
# Both ways to function URLs' and buckets' certificates: one for the domain by DNS, with a TSIG key as its Secret
# gives it, or one per host on demand.
validated=""
for mode in wildcard on-demand; do
  validated+="$(docker run --rm --read-only --tmpfs /tmp --tmpfs /data --cap-drop ALL --security-opt no-new-privileges --env-file "$platform/edge.env" \
      -e FF_FUNCTION_URL_TLS="$mode" -e FF_STORAGE_TLS="$mode" -e FF_DNS_TSIG_KEY="$(head -c 32 /dev/urandom | base64)" -v "$platform/edge/Caddyfile:/etc/caddy/Caddyfile:ro" \
      ff-edge:test caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >"$work/validate-$mode.log" 2>&1; echo $?) "
done
check "its Caddyfile, with its settings, valid for Caddy, function URLs' and buckets' certificates by DNS or on demand" "0 0 " "$validated"

echo "== the code registry"
# Zot's own check of its settings, in the image the Deployment pins, its storage and its users' file where the
# Deployment mounts them. A ghcr.io image: pulled without the caller's Docker logins, which ghcr.io may refuse.
read -r zot_image registry_checks < <(python3 - "$work/platform.yaml" "$platform/code-registry/config.json" <<'PY'
import json, sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d]
config = json.load(open(sys.argv[2]))
pod = next(d for d in docs if d['kind'] == 'Deployment' and d['metadata']['name'] == 'ff-code-registry')['spec']['template']['spec']
container = pod['containers'][0]
mounts = {m['name']: m['mountPath'] for m in container['volumeMounts']}
volumes = {v['name']: v for v in pod['volumes']}
storage = next(name for name, v in volumes.items() if 'persistentVolumeClaim' in v)
users = next(name for name, v in volumes.items() if v.get('secret', {}).get('secretName') == 'ff-code-registry')
ok = mounts[storage] == config['storage']['rootDirectory'] and f"{mounts[users]}/htpasswd" == config['http']['auth']['htpasswd']['path']
print(container['image'], 'mounted-where-read' if ok else 'mounted-elsewhere')
PY
)
mkdir -p "$work/docker" && echo '{}' >"$work/docker/config.json"
docker image inspect "$zot_image" >/dev/null 2>&1 || DOCKER_CONFIG="$work/docker" docker pull -q "$zot_image" >/dev/null
check "Zot's settings valid for its pinned image ($zot_image), its storage and its users where the Deployment mounts them" \
  "0 mounted-where-read" "$(docker run --rm -v "$platform/code-registry:/etc/zot:ro" "$zot_image" verify /etc/zot/config.json >"$work/zot-verify.log" 2>&1; echo $?) $registry_checks"
check "its Service at a fixed address on port 5000, which the backend pushes to by name and names in images" \
  "10.43.0.250:5000 http://ff-code-registry.ff-system.svc.cluster.local:5000 registry.ff.internal ff-backend" \
  "$(python3 - "$work/platform.yaml" <<'PY'
import sys, yaml
service = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d['kind'] == 'Service' and d['metadata']['name'] == 'ff-code-registry')
print(f"{service['spec']['clusterIP']}:{service['spec']['ports'][0]['port']}")
PY
) $(sed -n 's/^FF_CODE_REGISTRY=//p' "$platform/backend.env") $(sed -n 's/^FF_CODE_REGISTRY_PULL=//p' "$platform/backend.env") $(sed -n 's/^FF_CODE_REGISTRY_USERNAME=//p' "$platform/backend.env")"
check "the backend alone reaches it from a pod, on its port; nobody reads without a login" "backend-only 5000 ff-backend,ff-node" \
  "$(python3 - "$work/platform.yaml" "$platform/code-registry/config.json" <<'PY'
import json, sys, yaml
policy = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d['kind'] == 'NetworkPolicy' and d['metadata']['name'] == 'ff-code-registry')
rules = policy['spec']['ingress']
peers = [peer for rule in rules for peer in rule['from']]
only = all(set(peer) == {'podSelector'} and peer['podSelector'].get('matchLabels') == {'app.kubernetes.io/name': 'ff-backend'} for peer in peers)
ports = sorted({p['port'] for rule in rules for p in rule['ports']})
config = json.load(open(sys.argv[2]))
policies = config['http']['accessControl']['repositories']['ff-code/**']
anonymous = policies.get('anonymousPolicy') or policies.get('defaultPolicy')
users = ','.join(user for rule in policies['policies'] for user in rule['users'])
print('backend-only' if only and peers else 'open', ','.join(map(str, ports)), users if not anonymous else 'anonymous reads')
PY
)"

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

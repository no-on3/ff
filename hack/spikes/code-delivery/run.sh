#!/usr/bin/env bash
# How a function's zip, with its libraries, reaches its pods: the measurements behind ADR 0003.
# On a k3d cluster of its own, with a registry of its own (both removed on exit, the developer's
# cluster untouched), under runc and then gVisor, with the pod settings production uses, against
# today's ConfigMap: each function's code as one more layer on its runtime's image, run by digest
# (option A), and the code alone as an image, mounted at /var/task on its runtime's image (option
# C); libraries with native code (numpy, bcrypt) under a read-only root; how Kubernetes mounts an
# image volume; and the images pulled again once the node lost them. Results in
# hack/.code-delivery-spike/results.md.
#   hack/spikes/code-delivery/run.sh            (RUNS=5 by default: each start timed RUNS times)
set -euo pipefail
# The spike's own cluster, for env.sh and hack/k8s/gvisor-up.sh alike: its kubeconfig is its own too.
export FF_CLUSTER_NAME=ff-code-delivery
source "$(dirname "${BASH_SOURCE[0]}")/../../k8s/env.sh"

RUNS="${RUNS:-5}"
CRANE_VERSION=v0.22.1 # pinned to a release at least two weeks old when chosen
cluster="$FF_CLUSTER_NAME"
registry=ff-code-delivery-registry
registry_port="${REGISTRY_PORT:-5057}"
in_cluster="k3d-$registry:$registry_port" # the registry's name and port, as the cluster's containerd knows it
from_host="localhost:$registry_port"
work="$FF_REPO_ROOT/hack/.code-delivery-spike"
results="$work/results.md"
rm -rf "$work"
mkdir -p "$work/bin"

cleanup() {
  local status=$?
  jobs -p | xargs -r kill 2>/dev/null || true
  k3d cluster delete "$cluster" >/dev/null 2>&1 || true
  k3d registry delete "k3d-$registry" >/dev/null 2>&1 || true
  # The cluster's network, which k3d keeps while the registry is still on it.
  docker network rm "k3d-$cluster" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG"
  [ "$status" -eq 0 ] || echo "code-delivery spike: FAILED (its files: $work)" >&2
}
trap cleanup EXIT

note() { echo "$*" | tee -a "$results"; }
seconds_since() { awk -v start="$1" -v now="$(date +%s.%N)" 'BEGIN { printf "%.1f", now - start }'; }

echo "== resources"
MIN_MEM_AVAILABLE_MB=3000 "$FF_REPO_ROOT/hack/check-resources.sh"

echo "== crane $CRANE_VERSION, its checksum verified"
base="https://github.com/google/go-containerregistry/releases/download/$CRANE_VERSION"
curl -fsSL --retry 3 -o "$work/crane.tar.gz" "$base/go-containerregistry_Linux_x86_64.tar.gz"
expected="$(curl -fsSL --retry 3 "$base/checksums.txt" | awk '$2 == "go-containerregistry_Linux_x86_64.tar.gz" { print $1 }')"
[ "$(sha256sum "$work/crane.tar.gz" | cut -d' ' -f1)" = "$expected" ] || { echo "crane's checksum doesn't match" >&2; exit 1; }
tar -xzf "$work/crane.tar.gz" -C "$work/bin" crane
crane() { "$work/bin/crane" "$@"; }

echo "== a registry and a cluster of their own"
k3d registry create "$registry" --port "127.0.0.1:$registry_port" >/dev/null
k3d cluster create "$cluster" --image "$FF_K3S_IMAGE" --servers 1 --agents 0 --no-lb \
  --registry-use "$in_cluster" --k3s-arg "--disable=traefik@server:0" --k3s-arg "--disable=metrics-server@server:0" \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false --wait --timeout 180s >/dev/null
(umask 077 && k3d kubeconfig get "$cluster" >"$KUBECONFIG")
kubectl wait --for=condition=Ready node --all --timeout=120s >/dev/null
node="k3d-$cluster-server-0"
# gVisor, as production runs functions: installed now, while the node holds nothing, since it restarts the cluster.
gvisor=false
if "$FF_REPO_ROOT/hack/k8s/gvisor-up.sh" >"$work/gvisor.log" 2>&1; then gvisor=true; fi

echo "== the runtime images, pushed to it"
for image in ff-runtime-nodejs:24-v3 ff-runtime-python:3.13-v3; do
  docker image inspect "$image" >/dev/null
  docker tag "$image" "$from_host/ff/$image"
  docker push -q "$from_host/ff/$image" >/dev/null
done

echo "== the functions' code, with their libraries"
mkdir -p "$work/hello/var/task" "$work/numpy/var/task" "$work/bcrypt/var/task"
cat >"$work/hello/var/task/function.py" <<'PY'
def handler(event, context):
    return {"message": "Hello " + event.get("name", "world")}
PY
cat >"$work/numpy/var/task/function.py" <<'PY'
import numpy


def handler(event, context):
    a = numpy.arange(9, dtype=float).reshape(3, 3)
    return {"numpy": numpy.__version__, "trace": float(numpy.trace(a @ a))}
PY
# Wheels for the runtime's platform, as `ff package` will fetch them: x86_64, Python 3.13, needing glibc 2.28 at most (the image has 2.41).
docker run --rm -v "$work/numpy/var/task:/out" python:3.13-slim sh -c \
  'pip install -q --target /out --platform manylinux_2_28_x86_64 --python-version 3.13 --only-binary=:all: numpy==2.5.4 >/dev/null 2>&1 && chown -R '"$(id -u):$(id -g)"' /out'
cat >"$work/bcrypt/var/task/function.js" <<'JS'
const bcrypt = require('bcrypt');
exports.handler = async (event) => {
  const hash = bcrypt.hashSync(event.password ?? 'secret', 4);
  return { native: true, matches: bcrypt.compareSync(event.password ?? 'secret', hash) };
};
JS
# Built where the runtime runs: Alpine's musl, as ff-runtime-nodejs is today; from source when no prebuilt binary fits.
docker run --rm -v "$work/bcrypt/var/task:/out" -w /out node:24-alpine sh -c \
  'apk add --no-cache python3 make g++ >/dev/null && npm init -y >/dev/null && npm install --silent --omit=dev bcrypt@5.1.1 >/dev/null && chown -R '"$(id -u):$(id -g)"' /out'

# A layer: the code under var/task, owned by root, read-only (executables keep their x), at a fixed time, sorted.
layer() { # <directory> <layer file>
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='1980-01-01 00:00:00Z' --mode='a=rX' \
    -czf "$2" -C "$1" var/task
}
for name in hello numpy bcrypt; do
  layer "$work/$name" "$work/$name.tar.gz"
  # For an image volume: the code alone, at the image's root, mounted as /var/task.
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='1980-01-01 00:00:00Z' --mode='a=rX' \
    -czf "$work/$name-root.tar.gz" -C "$work/$name/var/task" .
done
note "# Code delivery spike, $(date -u +%Y-%m-%d)"
note ""
note "k3s $FF_K3S_IMAGE, one node; crane $CRANE_VERSION; $RUNS runs per start."
note ""
note "| Layer | Compressed | Unpacked |"
note "|---|---|---|"
for name in hello numpy bcrypt; do
  note "| $name | $(du -h "$work/$name.tar.gz" | cut -f1) | $(du -sh "$work/$name/var/task" | cut -f1) |"
done

echo "== option A, each function's image: its runtime's, and its code as one more layer; option C, its code alone"
image_of() { # <name> <runtime image>: the new image's reference by digest, as the cluster pulls it
  crane append --insecure -f "$work/$1.tar.gz" -b "$from_host/ff/$2" -t "$from_host/ff/fn-$1:spike" >/dev/null
  echo "$in_cluster/ff/fn-$1@$(crane digest --insecure "$from_host/ff/fn-$1:spike")"
}
code_of() { # <name>: the code alone as an image, by digest
  crane append --insecure -f "$work/$1-root.tar.gz" -t "$from_host/ff/code-$1:spike" >/dev/null 2>&1
  echo "$in_cluster/ff/code-$1@$(crane digest --insecure "$from_host/ff/code-$1:spike")"
}
python_base="$in_cluster/ff/ff-runtime-python:3.13-v3"
nodejs_base="$in_cluster/ff/ff-runtime-nodejs:24-v3"
hello_image="$(image_of hello ff-runtime-python:3.13-v3)"
numpy_image="$(image_of numpy ff-runtime-python:3.13-v3)"
bcrypt_image="$(image_of bcrypt ff-runtime-nodejs:24-v3)"
hello_code="$(code_of hello)"
numpy_code="$(code_of numpy)"
bcrypt_code="$(code_of bcrypt)"

# A pod as the backend makes a function's, but one: the image by digest and no code volume, or
# today's ConfigMap at /var/task, or an image volume there. Readiness every second, so that the
# timing's grain is fine.
pod() { # <name> <image> <memory> [configmap] [code image]
  local volumes="- { name: tmp, emptyDir: { sizeLimit: 512Mi } }" mounts="- { name: tmp, mountPath: /tmp }"
  if [ -n "${4:-}" ]; then
    volumes="$volumes
    - { name: code, configMap: { name: $4, defaultMode: 0444 } }"
  elif [ -n "${5:-}" ]; then
    volumes="$volumes
    - { name: code, image: { reference: $5, pullPolicy: IfNotPresent } }"
  fi
  if [ -n "${4:-}${5:-}" ]; then
    mounts="$mounts
        - { name: code, mountPath: /var/task, readOnly: true }"
  fi
  cat <<YAML
apiVersion: v1
kind: Pod
metadata: { name: $1, labels: { spike: code-delivery } }
spec:
  automountServiceAccountToken: false
  enableServiceLinks: false${RUNTIME_CLASS:+
  runtimeClassName: $RUNTIME_CLASS}
  securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: function
      image: $2
      imagePullPolicy: IfNotPresent
      ports: [{ name: http, containerPort: 8080 }]
      env:
        - { name: FUNCTION_NAME, value: $1 }
        - { name: FUNCTION_MEMORY_LIMIT, value: "$3" }
        - { name: FUNCTION_TIMEOUT, value: "10000" }
        - { name: LAMBDA_TASK_ROOT, value: /var/task }
        - { name: FF_HANDLER, value: function.handler }
        - { name: FF_EVENT_FORMAT, value: lambda }
        - { name: PORT, value: "8080" }
      resources: { requests: { memory: ${3}Mi }, limits: { memory: ${3}Mi } }
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      readinessProbe: { httpGet: { path: /readyz, port: http }, periodSeconds: 1, failureThreshold: 30 }
      volumeMounts:
        $mounts
  volumes:
    $volumes
YAML
}

# start <name> <image> <memory> [configmap] [code image]: seconds from the pod's creation to its readiness.
start() {
  local began
  kubectl delete pod "$1" --ignore-not-found --wait >/dev/null
  began="$(date +%s.%N)"
  pod "$@" | kubectl apply -f - >/dev/null
  kubectl wait --for=condition=Ready "pod/$1" --timeout=300s >/dev/null
  seconds_since "$began"
}

# call <pod> <event>: the function's answer, through the API server's proxy to the pod, as the development
# backend calls its functions: over the cluster's network, which reaches a gVisor sandbox too, where a
# port-forward into the pod's network namespace finds nothing listening.
call() {
  printf '%s' "$2" | kubectl create --raw "/api/v1/namespaces/default/pods/$1:8080/proxy/invoke" -f - 2>&1 | tr -d '\n'
}

times() { # <runs> <name> <image> <memory> [configmap] [code image]: each start's seconds
  local runs=$1 all=()
  shift
  for _ in $(seq 1 "$runs"); do all+=("$(start "$@")"); done
  echo "${all[*]}"
}

# forget <image>: the node's copy removed, as image garbage collection does, its base layers kept when shared.
forget() { docker exec "$node" crictl rmi "$1" >/dev/null 2>&1 || true; }
held() { if docker exec "$node" crictl inspecti "$1" >/dev/null 2>&1; then echo 1; else echo 0; fi; }

kubectl create configmap hello-code --from-file=function.py="$work/hello/var/task/function.py" >/dev/null
note ""
note "## The first pull on a node that has none of FF's images"
note ""
note "Option A's hello image, with its runtime's 120-odd MB: ready in $(start hello-a "$hello_image" 128) s."

# measure <runtime class, or none>: each way's starts, native code, and the image volume's mount.
measure() {
  export RUNTIME_CLASS="$1"
  local label="${1:-runc}"
  # No pod left to hold an image the node must lose.
  kubectl delete pod -l spike=code-delivery --wait >/dev/null
  echo "== $label: starts"
  note ""
  note "## Under $label"
  note ""
  note "Seconds from the pod's creation to its readiness: the first start after the node lost the function's image (its runtime kept), then $RUNS more."
  note ""
  note "| Way | First | Then |"
  note "|---|---|---|"
  note "| ConfigMap at /var/task (today) | | $(times "$RUNS" hello-configmap "$python_base" 128 hello-code) |"
  forget "$hello_image"
  note "| A: the function's image by digest | $(start hello-a "$hello_image" 128) | $(times "$RUNS" hello-a "$hello_image" 128) |"
  forget "$hello_code"
  note "| C: the runtime's image, the code an image volume | $(start hello-c "$python_base" 128 "" "$hello_code") | $(times "$RUNS" hello-c "$python_base" 128 "" "$hello_code") |"
  echo "== $label: native code under a read-only root"
  forget "$numpy_image"
  forget "$numpy_code"
  local numpy_a numpy_c bcrypt_a bcrypt_c
  numpy_a="$(start numpy-a "$numpy_image" 256)"
  numpy_c="$(start numpy-c "$python_base" 256 "" "$numpy_code")"
  bcrypt_a="$(start bcrypt-a "$bcrypt_image" 128)"
  bcrypt_c="$(start bcrypt-c "$nodejs_base" 128 "" "$bcrypt_code")"
  note ""
  note "Native code, with readOnlyRootFilesystem, uid 10001, no capability; each first start after the node lost its image:"
  note ""
  note "| Function | A: first start, answer | C: first start, answer |"
  note "|---|---|---|"
  note "| Python, numpy 2.5.4 (manylinux_2_28 wheels) | $numpy_a s, \`$(call numpy-a '{}')\` | $numpy_c s, \`$(call numpy-c '{}')\` |"
  note "| Node.js, bcrypt 5.1.1 (built on Alpine, as the runtime is) | $bcrypt_a s, \`$(call bcrypt-a '{"password": "hunter2"}')\` | $bcrypt_c s, \`$(call bcrypt-c '{"password": "hunter2"}')\` |"
  note ""
  note "The image volume's mount: \`$(kubectl exec numpy-c -- sh -c 'grep " /var/task " /proc/mounts' 2>&1 | awk '{ print $1, $2, $3, $4 }' | cut -c1-80)\`."
  kubectl delete pod -l spike=code-delivery --wait >/dev/null
}

measure ""

echo "== pulled again once the node lost it"
start numpy-a "$numpy_image" 256 >/dev/null
start numpy-c "$python_base" 256 "" "$numpy_code" >/dev/null
kubectl delete pod numpy-a numpy-c --wait >/dev/null
forget "$numpy_image"
forget "$numpy_code"
gone="$(held "$numpy_image") $(held "$numpy_code")"
repull_a="$(start numpy-a "$numpy_image" 256)"
repull_c="$(start numpy-c "$python_base" 256 "" "$numpy_code")"
note ""
note "## Pulled again"
note ""
note "Both images removed from the node (\`crictl rmi\`, as image GC does; copies left of each: $gone), the pods made again: A ready in $repull_a s, answering \`$(call numpy-a '{}')\`; C ready in $repull_c s, answering \`$(call numpy-c '{}')\`."
kubectl delete pod -l spike=code-delivery --wait >/dev/null

echo "== gVisor, as production runs functions"
if $gvisor; then
  measure gvisor
else
  note ""
  note "## Under gVisor"
  note ""
  note "Not measured: hack/k8s/gvisor-up.sh failed ($(tail -1 "$work/gvisor.log"))."
fi
echo "code-delivery spike: done; $results"

#!/usr/bin/env bash
# Development only: installs gVisor (runsc) in the k3d dev node, registers it
# with the node's containerd, applies the gvisor RuntimeClass, labels the node,
# and checks that a pod really runs under gVisor. Idempotent; the cluster
# restarts once (about 30 s) when the containerd configuration changes.
# Real nodes: docs/kubernetes-dev-guide.md, "Sandboxing with gVisor".
#   hack/k8s/gvisor-up.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

# Pinned to a release that was at least two weeks old, so it had time to be vetted.
GVISOR_RELEASE="${GVISOR_RELEASE:-20260928.0}"
node="k3d-$FF_CLUSTER_NAME-server-0"
bin_dir="$FF_REPO_ROOT/hack/bin/gvisor-$GVISOR_RELEASE"
dropin_dir=/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d
# Only what sandboxing needs: the release's checkpoint and metrics tools stay out.
files=(runsc containerd-shim-runsc-v1 gvisor-bin/gvisor_sentry gvisor-bin/gvisor-sentry-prewarmer gvisor-bin/runsc-fd-parking)
dropin="version = 3

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = \"io.containerd.runsc.v1\""

"$FF_REPO_ROOT/hack/check-resources.sh"
if ! k3d cluster get "$FF_CLUSTER_NAME" >/dev/null 2>&1; then
  echo "cluster $FF_CLUSTER_NAME not found: run hack/k8s/cluster-up.sh first" >&2
  exit 1
fi

# 1. The release, checked against the SHA-512 it is published with.
if [ ! -x "$bin_dir/runsc" ]; then
  case "$(uname -m)" in
    x86_64 | aarch64) arch="$(uname -m)" ;;
    *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  mkdir -p "$FF_REPO_ROOT/hack/bin"
  tmp="$(mktemp -d "$FF_REPO_ROOT/hack/bin/.gvisor-XXXXXX")" # on disk: /tmp may be memory-backed
  trap 'rm -rf "$tmp"' EXIT
  base="https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/$arch"
  curl -fsSL --retry 3 -o "$tmp/gvisor.tar.zstd" "$base/gvisor.tar.zstd"
  curl -fsSL --retry 3 -o "$tmp/gvisor.tar.zstd.sha512" "$base/gvisor.tar.zstd.sha512"
  (cd "$tmp" && sha512sum -c --quiet gvisor.tar.zstd.sha512)
  mkdir -p "$tmp/x" "$bin_dir/gvisor-bin"
  tar --zstd -xf "$tmp/gvisor.tar.zstd" -C "$tmp/x" "${files[@]}"
  for f in "${files[@]}"; do install -m 0755 "$tmp/x/$f" "$bin_dir/$f"; done
  echo "downloaded gVisor $GVISOR_RELEASE (sha512 verified)"
fi

# 2. The binaries in the node, next to each other as runsc expects.
if ! docker exec "$node" runsc --version 2>/dev/null | grep -q "release-$GVISOR_RELEASE"; then
  docker exec "$node" mkdir -p /usr/local/bin/gvisor-bin
  for f in "${files[@]}"; do docker cp "$bin_dir/$f" "$node:/usr/local/bin/$f"; done
  docker exec "$node" chown -R root:root /usr/local/bin
  echo "installed runsc $GVISOR_RELEASE in $node"
fi

# 3. The runsc runtime for containerd, as a drop-in that k3s imports.
if [ "$(docker exec "$node" cat "$dropin_dir/10-gvisor.toml" 2>/dev/null || true)" != "$dropin" ]; then
  docker exec "$node" mkdir -p "$dropin_dir"
  printf '%s\n' "$dropin" | docker exec -i "$node" sh -c "cat > $dropin_dir/10-gvisor.toml"
  echo "registered runsc with containerd; restarting $FF_CLUSTER_NAME to load it"
  k3d cluster stop "$FF_CLUSTER_NAME" >/dev/null
  k3d cluster start "$FF_CLUSTER_NAME" >/dev/null
  kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
fi

# 4. The RuntimeClass, and the node label its nodeSelector requires.
kubectl apply -f "$FF_REPO_ROOT/deploy/k8s/optional/runtimeclass-gvisor.yaml" >/dev/null
kubectl label node "$node" ff.dev/gvisor=true --overwrite >/dev/null

# 5. Proof: gVisor reports its own kernel version, not the host's.
image=ff-runtime-nodejs:24-v3
docker exec "$node" crictl inspecti "docker.io/library/$image" >/dev/null 2>&1 ||
  "$FF_REPO_ROOT/hack/k8s/load-images.sh" "$image" >/dev/null
kubectl -n default delete pod ff-gvisor-check --ignore-not-found --wait=true >/dev/null
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata: {name: ff-gvisor-check, namespace: default}
spec:
  runtimeClassName: gvisor
  restartPolicy: Never
  containers:
    - name: check
      image: $image
      imagePullPolicy: Never
      command: ["node", "-e", "console.log(require('os').release())"]
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
EOF
kubectl -n default wait --for=jsonpath='{.status.phase}'=Succeeded pod/ff-gvisor-check --timeout=120s >/dev/null
kernel="$(kubectl -n default logs ff-gvisor-check)"
kubectl -n default delete pod ff-gvisor-check --wait=false >/dev/null
case "$kernel" in
  *gvisor*) echo "gVisor works: a pod with runtimeClassName gvisor reports kernel $kernel (the node runs $(uname -r))" ;;
  *) echo "expected a gVisor kernel, got: $kernel" >&2; exit 1 ;;
esac
echo "use it with K8S_RUNTIME_CLASS=gvisor in BE/.env"

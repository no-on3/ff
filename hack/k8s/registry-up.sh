#!/usr/bin/env bash
# The dev cluster's registry for functions' code images (ADR 0003): a registry container on the
# cluster's Docker network, its port on 127.0.0.1 for the backend, which pushes, and each node's
# containerd told to pull from it over plain HTTP. Nothing restarts: containerd reads a registry's
# hosts.toml at each pull, and registries.yaml has k3s write it again when it starts. Idempotent:
# cluster-up.sh runs it, and so do the end-to-end scripts, for a cluster made before it.
#   hack/k8s/registry-up.sh
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

network="k3d-$FF_CLUSTER_NAME"
pull="$FF_REGISTRY_NAME:5000"
docker network inspect "$network" >/dev/null 2>&1 || { echo "no cluster $FF_CLUSTER_NAME: run hack/k8s/cluster-up.sh" >&2; exit 1; }

# Deletes allowed, as production's registry allows the backend: the purge of unused packages deletes their images,
# and the end-to-end checks delete one to see it made again. A container made before without them is made again,
# its volume kept.
if docker container inspect "$FF_REGISTRY_NAME" >/dev/null 2>&1 &&
  ! docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$FF_REGISTRY_NAME" | grep -x 'REGISTRY_STORAGE_DELETE_ENABLED=true' >/dev/null; then
  docker rm -f "$FF_REGISTRY_NAME" >/dev/null
fi
if ! docker container inspect "$FF_REGISTRY_NAME" >/dev/null 2>&1; then
  docker image inspect "$FF_REGISTRY_IMAGE" >/dev/null 2>&1 || docker pull -q "$FF_REGISTRY_IMAGE" >/dev/null
  # Its images in a volume of their own, kept when the container goes: a backend rebuilds a lost one from its package.
  docker run -d --name "$FF_REGISTRY_NAME" --restart unless-stopped --network "$network" \
    -p "127.0.0.1:$FF_REGISTRY_PORT:5000" -e REGISTRY_LOG_LEVEL=warn -e REGISTRY_STORAGE_DELETE_ENABLED=true \
    -v "$FF_REGISTRY_NAME:/var/lib/registry" --label ff.dev/role=code-registry "$FF_REGISTRY_IMAGE" >/dev/null
fi
[ "$(docker container inspect -f '{{.State.Running}}' "$FF_REGISTRY_NAME")" = true ] || docker start "$FF_REGISTRY_NAME" >/dev/null
# A cluster made again has a new network.
docker container inspect -f '{{json .NetworkSettings.Networks}}' "$FF_REGISTRY_NAME" | grep "\"$network\"" >/dev/null ||
  docker network connect "$network" "$FF_REGISTRY_NAME"

hosts="server = \"http://$pull\"
[host.\"http://$pull\"]
  capabilities = [\"pull\", \"resolve\"]"
mirror="mirrors:
  \"$pull\":
    endpoint:
      - \"http://$pull\""
nodes="$(docker ps --filter "label=k3d.cluster=$FF_CLUSTER_NAME" --format '{{.Names}} {{.Label "k3d.role"}}' | awk '$2 == "server" || $2 == "agent" { print $1 }')"
[ -n "$nodes" ] || { echo "cluster $FF_CLUSTER_NAME has no running node: hack/bin/k3d cluster start $FF_CLUSTER_NAME" >&2; exit 1; }
for node in $nodes; do
  docker exec -i "$node" sh -c "mkdir -p '/var/lib/rancher/k3s/agent/etc/containerd/certs.d/$pull' && cat > '/var/lib/rancher/k3s/agent/etc/containerd/certs.d/$pull/hosts.toml'" <<<"$hosts"
  current="$(docker exec "$node" sh -c 'cat /etc/rancher/k3s/registries.yaml 2>/dev/null' || true)"
  if [ -z "$current" ]; then
    docker exec -i "$node" sh -c 'cat > /etc/rancher/k3s/registries.yaml' <<<"$mirror"
  elif ! grep -q "\"$pull\"" <<<"$current"; then
    echo "warning: $node has its own /etc/rancher/k3s/registries.yaml: add $pull to it, or a restart of k3s forgets the registry" >&2
  fi
done

for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:$FF_REGISTRY_PORT/v2/" && break
  sleep 0.5
done
curl -fsS -o /dev/null "http://127.0.0.1:$FF_REGISTRY_PORT/v2/" || { echo "the registry doesn't answer on 127.0.0.1:$FF_REGISTRY_PORT" >&2; exit 1; }
echo "registry $FF_REGISTRY_NAME: pushed to on 127.0.0.1:$FF_REGISTRY_PORT, pulled from as $pull"

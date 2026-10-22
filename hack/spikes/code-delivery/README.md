# Code delivery spike

The measurements behind [ADR 0003](../../../docs/adr/0003-code-delivery.md): how a function's zip, with its libraries, reaches its pods. The [CLI plan](../../../docs/cli-plan.md)'s C-20.

```bash
hack/spikes/code-delivery/run.sh           # about 10 minutes, the first time: images to pull, wheels and packages to fetch
RUNS=10 hack/spikes/code-delivery/run.sh   # each start timed 10 times
```

It needs Docker, the runtime images (`ff-runtime-nodejs:24-v3`, `ff-runtime-python:3.13-v3`, as `hack/k8s/load-images.sh` builds them), `hack/bin`'s k3d and kubectl, and about 3 GB of memory free. The results go to `hack/.code-delivery-spike/results.md`, with the layers, the code, and crane.

## What it does

- **A cluster and a registry of its own,** `ff-code-delivery` and `k3d-ff-code-delivery-registry` on `127.0.0.1:5057`, the cluster using the registry (`--registry-use`), both removed on exit: the developer's `ff-dev` is never touched. gVisor is installed first, while the node holds nothing, since installing it restarts the cluster. The runtime images are pushed to the registry.
- **The code:** a Python hello; a Python function using numpy, from manylinux wheels that need glibc 2.28 at most (the image has 2.41), for Python 3.13 on x86_64, as `ff package` will fetch them; a Node.js function using bcrypt, built on Alpine as the Node.js runtime is today. Each becomes two layers, its files under `var/task` and its files at the root, both owned by root, read-only (executables keep their `x`), at a fixed time, in order.
- **Option A, the image per version:** the first layer appended to its runtime's image with [crane](https://github.com/google/go-containerregistry) (pinned, its checksum verified), the result run by digest, with no code volume.
- **Option C, the image volume:** the second layer alone as an image, mounted by digest at `/var/task` on the runtime's image, with Kubernetes' `image` volume.
- **The measures,** under runc, then under gVisor when it installed, in pods with the settings production uses (uid 10001, a read-only root, no capability, `/tmp` its own):
  - from the pod's creation to its readiness, `RUNS` times each: today's ConfigMap at `/var/task` on the runtime's image, A and C, each first start after the node lost the function's image apart; and, once, the first pull on a node that has none of FF's images;
  - numpy's and bcrypt's native code loading, A and C, and their answers;
  - how the image volume is mounted, from `/proc/mounts`;
  - under runc, the node's copies of both numpy images removed, as image garbage collection does, and the pods made again: pulled again, ready, answering.
- **Calls** go through the API server's proxy to the pod, as the development backend calls its functions: a `kubectl port-forward` into a gVisor pod finds nothing listening, the sandbox having its own network stack.

Option B (an init container fetching the zip from the object store) and option D (several ConfigMaps) aren't run: the ADR says why.

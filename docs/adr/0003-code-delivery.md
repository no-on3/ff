# ADR 0003: How a function's code reaches its pods

| | |
|---|---|
| **Status** | Proposed on 2026-10-21, for you to confirm: it adds a registry to the platform, which the [CLI plan](../cli-plan.md)'s question 2 asks you about |
| **Supersedes** | For packages, the code ConfigMap of the [Kubernetes migration](../kubernetes-migration-plan.md) (K-03); inline code moves to the same path once this is built (the CLI plan's C-24) |
| **Implementation** | The CLI plan's C-21 to C-26, the [step-1 plan](../step-1-plan.md)'s U-08 |
| **Evidence** | The spike `hack/spikes/code-delivery/run.sh` (the CLI plan's C-20), measured on 2026-10-21 |
| **Related** | [ADR 0001](0001-orchestrator-kubernetes.md) (Kubernetes), [ADR 0002](0002-cli.md) (the CLI and Lambda's packaging rules), the [parent plan](../local-markets-and-aws-portability-plan.md)'s §6.1 (packaging; customers' own images later) |

## Context

A function is one file today, at most 900 KiB, kept in an immutable ConfigMap that its pods mount at `/var/task`. A real function needs libraries: a database driver, an SDK, numpy. Packaged as AWS Lambda packages them (a zip, the handler at its root, `node_modules/` or the Python packages beside it), that is often 10 to 100 MB, up to Lambda's 250 MB unzipped: far past a ConfigMap's 1 MiB.

What the answer must keep:
- **Pods start, and start again, at any time:** scaled from zero, moved, a node restarted. A pod made months after its version must find its code.
- **Tenant pods reach nothing private:** their namespace's default-deny policy blocks every private address, FF's object store among them (client-readiness plan, D5).
- **Production's pod settings:** uid 10001, a read-only root, no capability, and gVisor.
- **Native code must load:** numpy's `.so` files, a Node.js module's `.node`.
- **The backend's rights stay small:** it writes a tenant's Deployments, Services, ConfigMaps and Secrets, and nothing on the nodes.

The CLI plan named four ways (its D4):
- **A.** The runtime's image with the code as one more layer, one image per version, run by digest from a registry in the cluster.
- **B.** An init container that fetches the zip from the object store into an `emptyDir`.
- **C.** The code alone as an image, mounted at `/var/task` with Kubernetes' `image` volume. The plan expected such a volume to be mounted `noexec`, so that native code couldn't load.
- **D.** Several ConfigMaps.

## What the spike measured

On a k3d cluster of its own, k3s v1.37.1, with a registry of its own: a Python hello, a Python function using numpy 2.5.4 (manylinux_2_28 wheels: 20 MB compressed, 69 MB unpacked), a Node.js function using bcrypt 5.1.1, built on Alpine as the Node.js runtime is (672 KB, 4.3 MB). Each as A and as C, in pods with production's settings, under runc and under gVisor. Seconds from the pod's creation to its readiness, the probe asking every second; each first start after the node lost the function's image, its runtime's image kept:

| Way | runc: first | runc: then (5 runs) | gVisor: first | gVisor: then (5 runs) |
|---|---|---|---|---|
| The ConfigMap, today | | 2.0 2.3 2.0 1.0 1.0 | | 1.6 1.0 1.0 2.0 1.0 |
| A: the function's image | 1.8 | 1.0 1.7 1.0 1.0 1.7 | 1.8 | 1.0 1.0 1.0 1.0 1.0 |
| C: the code as an image volume | 1.9 | 2.0 2.0 2.0 2.0 2.0 | 1.8 | 1.0 1.0 1.0 1.0 1.9 |

| Native code, first start | A, runc | C, runc | A, gVisor | C, gVisor |
|---|---|---|---|---|
| numpy: `numpy.trace(a @ a)` answers 180.0 | 2.7 s | 3.0 s | 2.4 s | 3.0 s |
| bcrypt: a hash made and checked | 2.8 s | 3.9 s | 3.0 s | 2.0 s |

- **Every way starts within the probe's grain of today's,** once the node has the code; a new version's first start, which pulls only its code, adds about a second, or two for 20 MB of numpy. A node that has none of FF's images pulled a function's image, its runtime's 120-odd MB with it, in 4 to 6 s.
- **Native code loads** both ways, under both runtimes, with a read-only root, uid 10001 and no capability.
- **An image volume is mounted read-only, not `noexec`:** `overlay … ro,relatime` under runc, `9p ro,trans=fd` under gVisor. The plan's worry about C was unfounded on the Kubernetes FF runs: k3s v1.37.1 took the volume with no setting, its containerd mounting it.
- **A lost image comes back:** both images removed from the node (`crictl rmi`, as image garbage collection does), the pods made again pulled them and answered, in 2 to 2.3 s.
- **Calls under gVisor** go over the cluster's network, as the backend's do: a `kubectl port-forward` into a gVisor pod finds nothing listening, since the sandbox has a network stack of its own.

## Decision

**C: each version of a function's code is an image of its own, in a registry in the cluster, mounted read-only at `/var/task` on its runtime's image.**

- **The code image:** one layer, the package's files at its root, owned by root, read-only (executables keep their `x`), in a fixed order and time, so that the same package makes the same layer; a minimal configuration. The backend builds it from the validated zip (C-22) and pushes it (C-23); its digest is the version's.
- **The pod:** the runtime's image, as today, and an `image` volume by digest at `/var/task`, in place of the code ConfigMap. The kubelet pulls it over the node's network, so no tenant policy opens.
- **The registry:** Zot in production (one binary, garbage collection built in); in development, k3d's registry, which `hack/k8s/cluster-up.sh` makes and the cluster uses. The backend alone writes to it.
- **What is kept:** each function's current and previous versions; older manifests are deleted, and the registry collects their blobs. The zips stay in the object store, from which an image can be made again.
- **Inline code follows** (C-24): a one-file package, the same path, so that code ConfigMaps go, and their 900 KiB with them; the API's `code` field stays for the console and quick edits.

## Consequences

- **A runtime's update reaches every function without rebuilding its code:** the Deployment's runtime image changes, its code image doesn't, and the rollout is today's. With A, each function's image would have to be made again on every runtime release.
- **The push is small:** one layer and a manifest, no base to mount, no configuration to edit; content-addressed, so a package sent twice is pushed once.
- **A registry joins the platform,** to run, back up (or rebuild from the zips) and keep within its disk; its address in the cluster's containerd configuration.
- **Kubernetes must take image volumes:** k3s v1.37.1 does, as it comes. A cluster without them can't run packaged functions, which the deploy checks will say.
- **Customers' own images** (the parent plan's §6.1) can come later through the same registry, as A-like images.
- **The CLI's packages** (C-26) fetch Python wheels for the runtime's glibc, `manylinux_2_28` (the image has 2.41), not `manylinux2014`, which holds numpy to 2.2.

## Alternatives considered

- **A, one image per version.** Measured as good as C. But every runtime release means making every function's image again, and the push must mount the runtime's layers and rewrite its configuration; the version ties its code to one build of its runtime.
- **B, an init container fetching the zip.** A presigned URL in the pod's spec expires within 7 days, so a pod made later can't fetch its code, unless the tenant holds object-store credentials, which the backend deliberately can't manage; the tenant's policy would need an exception to reach the store; and every start copies the package to an `emptyDir`. Not measured: each of these rules it out.
- **D, several ConfigMaps.** A ConfigMap holds 1 MiB, so a 100 MB package is a hundred objects in etcd, which isn't a file store. Not measured.

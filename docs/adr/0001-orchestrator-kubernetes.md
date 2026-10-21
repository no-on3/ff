# ADR 0001: Kubernetes as the FF orchestrator

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-16 |
| **Supersedes** | Nomad-based scheduling (`BE/src/nomad/`) |
| **Implementation** | [Kubernetes migration plan](../kubernetes-migration-plan.md) |

## Context

FF schedules each function as a HashiCorp Nomad job. Three facts make Nomad a poor foundation for a commercial product that FF will sell as a hosted service *and* as an on-prem package.

1. **Licence.** Nomad is under the Business Source License 1.1, with IBM as licensor since March 2026. The Additional Use Grant forbids "offering the Licensed Work to third parties on a hosted or embedded basis in order to compete with IBM Corp's paid version(s)".
   - "Embedded" explicitly includes packaging a product so that Nomad "must be accessed or downloaded for the competitive offering to operate". The on-prem edition would meet that definition by construction.
   - The hosted case is plausibly allowed, but not settled.
   - No maintained open-source fork exists, and the last MPL release (1.6.5) is unpatched.
2. **Isolation.** There is no maintained Firecracker task driver for Nomad, and Kata through Nomad is untested, so the microVM tier the plan needs has no path.
3. **Multi-tenancy cost.** Resource quotas are a Nomad Enterprise feature.

The current Nomad integration (`nomad.service.ts`, about 370 lines) must be rewritten anyway: it injects code into templates, its delete and update are no-ops, and it has no isolation. So the cost of switching is lowest now.

## Decision

Use **Kubernetes**, and only as the internal scheduler:

- **Distributions:** k3s for development and FF Cloud; RKE2 recommended for on-prem banks and government. Workloads are plain Kubernetes manifests, so any certified distribution works.
- **Isolation:**
  - a namespace per tenant;
  - the Pod Security "restricted" profile;
  - default-deny network policy;
  - ResourceQuota and LimitRange;
  - hardened pods;
  - gVisor via RuntimeClass, and Kata/Firecracker for a microVM tier.
- **The backend's identity:** a ServiceAccount whose cluster-wide RBAC is narrowed to FF-managed tenant namespaces by a `ValidatingAdmissionPolicy`.
- **Client:** a small in-house API client (ServiceAccount token, server-side apply). The official `@kubernetes/client-node` 2.x is ESM-only, which conflicts with the CommonJS NestJS and Jest setup, and FF needs only about ten calls.
- **No serverless framework's function format** (OpenFaaS, Fission, OpenWhisk, Knative Functions) is adopted. FF keeps its own contract, which converges on AWS Lambda's (parent plan, principle P1).

## Alternatives considered

| Option | Outcome |
|---|---|
| Keep Nomad; ask IBM for written confirmation, or buy a commercial licence | Rejected. Uncertain for on-prem; paid in USD; no microVM path |
| Kubernetes + Knative Serving | Deferred. Useful for scale-to-zero, but it adds a second proxy and operational weight. Can be revisited later. |
| OpenFaaS / Fission / OpenWhisk on Kubernetes | Rejected. They impose their own function format, which breaks Lambda portability. OpenFaaS CE is not licensed for commercial use beyond a 60-day trial; OpenWhisk is dormant. |
| Own scheduler on containerd or Firecracker | Deferred. Best cold starts and isolation, but about 10–20 extra person-weeks |
| Docker Swarm | Rejected. No namespaces, network policies, or quotas for multi-tenancy |

## Consequences

**Positive:**
- No licence risk: Apache-2.0 software, governed by the CNCF foundation.
- Free quotas and network policy.
- A clear isolation roadmap.
- On-prem buyers who already run Kubernetes can install FF on their cluster.

**Negative:**
- More operational complexity than Nomad.
- The team must learn Kubernetes.

  Mitigated by k3s, scripted operations in `hack/`, and a resource-capped dev cluster.

**Follow-ups:**
- The Lambda Runtime API agent (parent plan R-04) will run as a sidecar container in the same pod.
- Zip artifacts from S3 (R-02) will replace the ConfigMap code delivery, lifting the 900 KiB limit. **Done** another way: [ADR 0003](0003-code-delivery.md) delivers every function's code as an image, the CLI plan's C-23 and C-24 built it, and inline code may have 3 MiB.

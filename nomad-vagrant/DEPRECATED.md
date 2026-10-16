# Deprecated: Nomad development VM

FF no longer uses Nomad. Functions run on Kubernetes ([ADR 0001](../docs/adr/0001-orchestrator-kubernetes.md)), and the Nomad driver was removed from the backend in K-09 of the [migration plan](../docs/kubernetes-migration-plan.md).

This Vagrant setup is kept only for reference. For local development use the Kubernetes dev cluster instead:

```bash
hack/k8s/cluster-up.sh     # see docs/kubernetes-dev-guide.md
```

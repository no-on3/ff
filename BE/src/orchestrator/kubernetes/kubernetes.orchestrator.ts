import { Logger } from '@nestjs/common';
import * as http from 'node:http';
import { FunctionRuntimeError, FunctionTimeoutError, OrchestratorError } from '../orchestrator.errors';
import { FunctionWorkload, InvokeResult, Orchestrator } from '../orchestrator.types';
import { KubeApi, KubeResponse, paths } from './kube-client';
import { KubernetesSettings } from './kubernetes.settings';
import {
  K8sObject,
  RUNTIME_PORT,
  TENANT_LIMITS_NAME,
  TENANT_NETWORK_POLICY_NAME,
  TENANT_QUOTA_NAME,
  codeConfigMapManifest,
  deploymentManifest,
  limitRangeManifest,
  namespaceManifest,
  networkPolicyManifest,
  resourceQuotaManifest,
  serviceManifest,
} from './manifests';
import { LABELS, codeConfigMapName, codeHash, functionResourceName, tenantNamespace } from './naming';

interface Deployment extends K8sObject {
  metadata: K8sObject['metadata'] & { generation?: number };
  spec?: { replicas?: number };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
  };
}

interface Listed extends K8sObject {
  metadata: K8sObject['metadata'] & { creationTimestamp?: string };
}

interface Pod extends Listed {
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string } };
    }>;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The rollout is finished: every replica runs the new template and is available (as `kubectl rollout status`). */
export function isRolledOut(deployment: Deployment): boolean {
  const desired = deployment.spec?.replicas ?? 1;
  const status = deployment.status ?? {};
  return (
    (status.observedGeneration ?? 0) >= (deployment.metadata.generation ?? 0) &&
    (status.updatedReplicas ?? 0) >= desired &&
    (status.replicas ?? 0) <= (status.updatedReplicas ?? 0) &&
    (status.availableReplicas ?? 0) >= desired
  );
}

/**
 * Runs each function as a Deployment in its tenant's namespace (one namespace
 * per user), with code in an immutable ConfigMap and a ClusterIP Service in
 * front. See docs/kubernetes-migration-plan.md, K-06.
 */
export class KubernetesOrchestrator implements Orchestrator {
  private readonly logger = new Logger(KubernetesOrchestrator.name);

  constructor(
    private readonly settings: KubernetesSettings,
    private readonly api: KubeApi,
    private readonly pollIntervalMs = 1000,
  ) {}

  private namespaceOf(fn: FunctionWorkload): string {
    return tenantNamespace(this.settings.namespacePrefix, fn.userId);
  }

  async deploy(fn: FunctionWorkload): Promise<void> {
    await this.apply(fn);
  }

  async update(fn: FunctionWorkload): Promise<void> {
    await this.apply(fn);
  }

  private async ensureTenant(fn: FunctionWorkload, ns: string): Promise<void> {
    await this.api.apply(paths.namespace(ns), namespaceManifest(ns, fn.userId));
    await this.api.apply(paths.core(ns, 'resourcequotas', TENANT_QUOTA_NAME), resourceQuotaManifest(ns, this.settings));
    await this.api.apply(paths.core(ns, 'limitranges', TENANT_LIMITS_NAME), limitRangeManifest(ns));
    await this.api.apply(
      paths.networking(ns, 'networkpolicies', TENANT_NETWORK_POLICY_NAME),
      networkPolicyManifest(ns, this.settings),
    );
  }

  private async apply(fn: FunctionWorkload): Promise<void> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    const hash = codeHash(fn.runtime, fn.code);
    const configMap = codeConfigMapName(fn.id, hash);
    const configMapManifest = codeConfigMapManifest(fn, ns, configMap, hash); // validates size first

    await this.ensureTenant(fn, ns);
    await this.api.apply(paths.core(ns, 'configmaps', configMap), configMapManifest);
    await this.api.apply(paths.core(ns, 'services', name), serviceManifest(fn, ns));

    // Keep the current replica count (it may have been scaled since); never go below minInstances.
    const existing = await this.api.get<Deployment>(paths.apps(ns, 'deployments', name));
    const replicas = Math.max(existing?.spec?.replicas ?? Math.max(1, fn.minInstances), fn.minInstances);
    await this.api.apply(
      paths.apps(ns, 'deployments', name),
      deploymentManifest(fn, ns, configMap, hash, this.settings, replicas),
    );
    await this.collectOldConfigMaps(fn, ns, configMap);
  }

  /** Keeps the current code ConfigMap and the newest previous one (still used during rollouts). */
  private async collectOldConfigMaps(fn: FunctionWorkload, ns: string, current: string): Promise<void> {
    const configMaps = await this.api.list<Listed>(paths.core(ns, 'configmaps'), `${LABELS.functionId}=${fn.id}`);
    const older = configMaps
      .filter((cm) => cm.metadata.name !== current)
      .sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''));
    for (const cm of older.slice(1)) {
      await this.api.delete(paths.core(ns, 'configmaps', cm.metadata.name));
    }
  }

  async remove(fn: FunctionWorkload): Promise<void> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    await this.api.delete(paths.apps(ns, 'deployments', name));
    await this.api.delete(paths.core(ns, 'services', name));
    await this.api.deleteCollection(paths.core(ns, 'configmaps'), `${LABELS.functionId}=${fn.id}`);
  }

  async waitUntilReady(fn: FunctionWorkload, timeoutMs: number): Promise<void> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const deployment = await this.api.get<Deployment>(paths.apps(ns, 'deployments', name));
      if (!deployment) throw new OrchestratorError(`Deployment ${ns}/${name} does not exist`);
      if (isRolledOut(deployment)) return;
      if (Date.now() >= deadline) break;
      await sleep(this.pollIntervalMs);
    }
    const diagnostics = await this.diagnose(fn, ns);
    throw new OrchestratorError(
      `Function "${fn.name}" did not become ready within ${Math.round(timeoutMs / 1000)} s${diagnostics ? `: ${diagnostics}` : ''}`,
    );
  }

  /** Why pods are not ready: container waiting reasons plus the newest pod's last log lines. */
  private async diagnose(fn: FunctionWorkload, ns: string): Promise<string> {
    try {
      const pods = await this.api.list<Pod>(paths.core(ns, 'pods'), `${LABELS.functionId}=${fn.id}`);
      if (pods.length === 0) return 'no pods were created (check the tenant ResourceQuota and events)';
      const reasons = new Set<string>();
      for (const pod of pods) {
        for (const status of pod.status?.containerStatuses ?? []) {
          const waiting = status.state?.waiting;
          if (waiting?.reason) reasons.add(waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason);
          if (status.state?.terminated?.reason) reasons.add(`terminated: ${status.state.terminated.reason}`);
        }
        if (!pod.status?.containerStatuses?.length && pod.status?.phase) reasons.add(`pod ${pod.status.phase}`);
      }
      const newest = [...pods].sort((a, b) =>
        (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''),
      )[0];
      const log = (await this.api.podLog(ns, newest.metadata.name, 'function', 20)).trim();
      return [...reasons, log && `last log lines: ${log.split('\n').slice(-5).join(' | ')}`].filter(Boolean).join('; ');
    } catch (err) {
      return `diagnostics unavailable (${(err as Error).message})`;
    }
  }

  async scale(fn: FunctionWorkload, replicas: number): Promise<void> {
    await this.api.scaleDeployment(this.namespaceOf(fn), functionResourceName(fn.id), Math.max(0, Math.floor(replicas)));
  }

  async readyInstances(fn: FunctionWorkload): Promise<number> {
    const deployment = await this.api.get<Deployment>(
      paths.apps(this.namespaceOf(fn), 'deployments', functionResourceName(fn.id)),
    );
    return deployment?.status?.readyReplicas ?? 0;
  }

  async invoke(fn: FunctionWorkload, payload: Record<string, unknown>): Promise<InvokeResult> {
    if ((await this.readyInstances(fn)) === 0) {
      this.logger.log(`Cold start: scaling ${fn.id} from zero`);
      await this.scale(fn, 1);
      await this.waitUntilReady(fn, this.settings.readyTimeoutSeconds * 1000);
    }
    return this.toResult(await this.post(fn, payload));
  }

  private post(fn: FunctionWorkload, payload: Record<string, unknown>): Promise<KubeResponse> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    const body = JSON.stringify(payload);
    const timeoutMs = fn.timeout * 1000 + 2000;
    if (this.settings.invokeMode === 'proxy') {
      return this.api.request('POST', paths.serviceProxy(ns, name, 'http', '/invoke'), { body, timeoutMs });
    }
    return postJson(`http://${name}.${ns}.svc:${RUNTIME_PORT}/invoke`, body, timeoutMs);
  }

  private toResult(res: KubeResponse): InvokeResult {
    const parsed = (() => {
      try {
        return res.body ? JSON.parse(res.body) : null;
      } catch {
        return undefined;
      }
    })();
    if (res.status === 200 && parsed !== undefined) {
      return {
        output: parsed,
        durationMs: Number(res.headers['x-ff-duration-ms']) || undefined,
        memoryUsedMb: Number(res.headers['x-ff-max-memory-used-mb']) || undefined,
      };
    }
    if (parsed && typeof parsed.errorType === 'string') {
      if (parsed.errorType === 'Sandbox.Timedout') throw new FunctionTimeoutError(parsed.errorMessage);
      if (res.headers['x-ff-function-error']) throw new FunctionRuntimeError(parsed.errorType, parsed.errorMessage);
    }
    throw new OrchestratorError(`Invocation failed with HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
}

/** Direct (in-cluster) call to a function Service. */
function postJson(url: string, body: string, timeoutMs: number): Promise<KubeResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new FunctionTimeoutError(`No response within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

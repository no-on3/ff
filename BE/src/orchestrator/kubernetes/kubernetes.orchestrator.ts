import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import {
  FunctionLoadError,
  FunctionRuntimeError,
  FunctionThrottledError,
  FunctionTimeoutError,
  OrchestratorError,
  withInitMs,
} from '../orchestrator.errors';
import { describeError } from '../../common/describe-error';
import { REQUEST_ID_HEADER } from '../../common/request-context';
import { FunctionLogLine, FunctionLogsPage, FunctionWorkload, InvokeResult, LogsFilter, LogsQuery, Orchestrator, TenantLimits } from '../orchestrator.types';
import { KubeApi, KubeRequestTimeoutError, KubeResponse, paths } from './kube-client';
import { KubernetesSettings } from './kubernetes.settings';
import { LogStore, namespaceFilter, pageQuery, quoted, tailQuery, toLine, toPage } from './log-store';
import {
  K8sObject,
  RUNTIME_PORT,
  TENANT_LIMITS_NAME,
  TENANT_NETWORK_POLICY_NAME,
  TENANT_QUOTA_NAME,
  codeConfigMapManifest,
  deploymentManifest,
  environmentSecretManifest,
  hasEnvironment,
  limitRangeManifest,
  maxQueueWaitMs,
  namespaceManifest,
  networkPolicyManifest,
  resourceQuotaManifest,
  serviceManifest,
} from './manifests';
import {
  ANNOTATIONS,
  EnvironmentSlot,
  LABELS,
  MANAGED_BY,
  accountNamespace,
  codeConfigMapName,
  codeHash,
  environmentSecretName,
  environmentSlotOf,
  functionResourceName,
} from './naming';

interface Deployment extends K8sObject {
  metadata: K8sObject['metadata'] & { generation?: number };
  spec?: {
    replicas?: number;
    template?: {
      metadata?: Pick<K8sObject['metadata'], 'labels' | 'annotations'>;
      spec?: { containers?: Array<{ envFrom?: Array<{ secretRef?: { name?: string } }> }> };
    };
  };
  status?: {
    observedGeneration?: number;
    replicas?: number;
    updatedReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    conditions?: Array<{ type: string; status: string; message?: string }>;
  };
}

/** How long closing an account waits for its namespace to go, and for its log lines' deletion (P-45). */
export const TENANT_REMOVAL_TIMEOUT_MS = 120_000;
export const LOG_DELETION_TIMEOUT_MS = 120_000;

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

/** The newest of the pods, by creation time; undefined when there are none. */
function newestOf<T extends Listed>(pods: T[]): T | undefined {
  return [...pods].sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? ''))[0];
}

/**
 * Whether a pod runs the code and runtime the Deployment's template names now,
 * which decide whether the code loads. A rollback's wait thus never takes the
 * load error of the version it replaces for its own.
 */
function runsTemplate(pod: Pod, deployment: Deployment): boolean {
  const template = deployment.spec?.template?.metadata;
  return (
    pod.metadata.annotations?.[ANNOTATIONS.codeSha256] === template?.annotations?.[ANNOTATIONS.codeSha256] &&
    pod.metadata.labels?.[LABELS.runtime] === template?.labels?.[LABELS.runtime]
  );
}

/** The environment Secret a Deployment's pods read, its slot, and the revision its template names; none without one. */
function environmentInUse(fn: FunctionWorkload, deployment: Deployment | null): { name: string; slot: EnvironmentSlot; revision?: string } | undefined {
  const template = deployment?.spec?.template;
  const name = template?.spec?.containers?.[0]?.envFrom?.find((source) => source.secretRef?.name)?.secretRef?.name;
  const slot = name === undefined ? undefined : environmentSlotOf(fn.id, name);
  if (name === undefined || slot === undefined) return undefined;
  return { name, slot, revision: template?.metadata?.annotations?.[ANNOTATIONS.environmentRevision] };
}

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
 * Runs each function as a Deployment in its account's namespace (one namespace
 * per user), with inline code in an immutable ConfigMap, or a package's code
 * image mounted (ADR 0003), and a ClusterIP Service in front. See
 * docs/kubernetes-migration-plan.md, K-06.
 */
export class KubernetesOrchestrator implements Orchestrator {
  private readonly logger = new Logger(KubernetesOrchestrator.name);
  private readonly logStore: LogStore;

  /**
   * `loadCheckIntervalMs`: how often a wait for instances looks in the log store
   * for the runtime's load error, which reaches it a few seconds after the
   * runtime writes it.
   */
  constructor(
    private readonly settings: KubernetesSettings,
    private readonly api: KubeApi,
    private readonly pollIntervalMs = 1000,
    private readonly loadCheckIntervalMs = 3000,
  ) {
    this.logStore = new LogStore(settings.invokeMode, api);
  }

  private namespaceOf(fn: FunctionWorkload): string {
    return accountNamespace(this.settings.namespacePrefix, fn.accountId);
  }

  async deploy(fn: FunctionWorkload, tenant: TenantLimits): Promise<void> {
    await this.apply(fn, tenant);
  }

  async update(fn: FunctionWorkload, tenant: TenantLimits): Promise<void> {
    await this.apply(fn, tenant);
  }

  async applyTenantLimits(accountId: string, tenant: TenantLimits): Promise<void> {
    const ns = accountNamespace(this.settings.namespacePrefix, accountId);
    // Before its first function, an account has no namespace: that function's deploy applies the plan.
    if (!(await this.api.get(paths.namespace(ns)))) return;
    await this.api.apply(paths.core(ns, 'resourcequotas', TENANT_QUOTA_NAME), resourceQuotaManifest(ns, tenant.quota));
    await this.api.apply(
      paths.networking(ns, 'networkpolicies', TENANT_NETWORK_POLICY_NAME),
      networkPolicyManifest(ns, this.settings, tenant.internetEgress),
    );
  }

  /**
   * The account's namespace and guardrails, with its plan's quota and its internet egress: written again on
   * every deploy and update.
   */
  private async ensureTenant(fn: FunctionWorkload, ns: string, tenant: TenantLimits): Promise<void> {
    await this.api.apply(paths.namespace(ns), namespaceManifest(ns, fn.accountId));
    await this.api.apply(paths.core(ns, 'resourcequotas', TENANT_QUOTA_NAME), resourceQuotaManifest(ns, tenant.quota));
    await this.api.apply(paths.core(ns, 'limitranges', TENANT_LIMITS_NAME), limitRangeManifest(ns));
    await this.api.apply(
      paths.networking(ns, 'networkpolicies', TENANT_NETWORK_POLICY_NAME),
      networkPolicyManifest(ns, this.settings, tenant.internetEgress),
    );
  }

  private async apply(fn: FunctionWorkload, tenant: TenantLimits): Promise<void> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    // A package's code is its image, which names its version; inline code goes in a ConfigMap named by its hash.
    const hash = codeHash(fn.runtime, fn.codeImage ?? fn.code);
    const configMap = fn.codeImage ? undefined : codeConfigMapName(fn.id, hash);
    const configMapManifest = configMap ? codeConfigMapManifest(fn, ns, configMap, hash) : undefined; // validates size first

    await this.ensureTenant(fn, ns, tenant);
    if (configMap && configMapManifest) await this.api.apply(paths.core(ns, 'configmaps', configMap), configMapManifest);
    await this.api.apply(paths.core(ns, 'services', name), serviceManifest(fn, ns));

    // Keep the current replica count (it may have been scaled since), never below
    // minInstances, and never below one: every deploy and update is checked by
    // waitUntilReady, which needs a pod, even for a function scaled to zero. The
    // idle sweep scales it back down after the idle window.
    const existing = await this.api.get<Deployment>(paths.apps(ns, 'deployments', name));
    const replicas = Math.max(existing?.spec?.replicas ?? 0, fn.minInstances, 1);
    if (!Number.isFinite(replicas)) throw new OrchestratorError(`Invalid minInstances ${fn.minInstances} for function ${fn.id}`);
    const environmentSecret = await this.applyEnvironment(fn, ns, existing);
    await this.api.apply(
      paths.apps(ns, 'deployments', name),
      deploymentManifest(fn, ns, configMap, hash, this.settings, replicas, environmentSecret),
    );
    await this.collectOldConfigMaps(fn, ns, configMap);
  }

  /**
   * Writes the function's variables and secrets into the Secret that its running
   * version doesn't read, and returns that Secret's name for the Deployment: the
   * pods of the running version keep theirs during the rollout, and a rollback
   * finds the old values where they were. An environment that hasn't changed
   * stays where it is. Nothing for a function without one.
   */
  private async applyEnvironment(fn: FunctionWorkload, ns: string, existing: Deployment | null): Promise<string | undefined> {
    if (!hasEnvironment(fn)) return undefined;
    const inUse = environmentInUse(fn, existing);
    const slot: EnvironmentSlot = !inUse ? 0 : inUse.revision === fn.environment.revision ? inUse.slot : inUse.slot === 0 ? 1 : 0;
    const secret = environmentSecretName(fn.id, slot);
    await this.api.apply(paths.core(ns, 'secrets', secret), environmentSecretManifest(fn, ns, secret));
    return secret;
  }

  /**
   * Once a rollout is complete, deletes the environment Secret that no pod reads
   * any more, so that replaced and removed values leave the cluster; both, for a
   * function without an environment now. Best effort: a Secret left behind is
   * written over by the next change, and deleted with the function.
   */
  private async collectEnvironments(fn: FunctionWorkload, ns: string, deployment: Deployment): Promise<void> {
    const inUse = environmentInUse(fn, deployment)?.name;
    for (const slot of [0, 1] as const) {
      const secret = environmentSecretName(fn.id, slot);
      if (secret === inUse) continue;
      try {
        await this.api.delete(paths.core(ns, 'secrets', secret));
      } catch (error) {
        this.logger.warn(`Could not delete the unused environment Secret ${ns}/${secret}: ${describeError(error)}`);
      }
    }
  }

  /** Keeps the current code ConfigMap and the newest previous one (still used during rollouts); a package has none of its own. */
  private async collectOldConfigMaps(fn: FunctionWorkload, ns: string, current: string | undefined): Promise<void> {
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
    // By name: the backend may delete Secrets, never list them.
    for (const slot of [0, 1] as const) await this.api.delete(paths.core(ns, 'secrets', environmentSecretName(fn.id, slot)));
  }

  /**
   * Deletes the account's namespace, and with it everything left in it: its
   * quota, limits and network policy, and any function object (P-45). Waits
   * until the namespace is gone: one being deleted already is only waited for.
   */
  async removeTenant(accountId: string, timeoutMs = TENANT_REMOVAL_TIMEOUT_MS): Promise<void> {
    const ns = accountNamespace(this.settings.namespacePrefix, accountId);
    const current = await this.api.get<{ status?: { phase?: string } }>(paths.namespace(ns));
    if (!current) return;
    if (current.status?.phase !== 'Terminating') await this.api.delete(paths.namespace(ns));
    const deadline = Date.now() + timeoutMs;
    while (await this.api.get(paths.namespace(ns))) {
      if (Date.now() >= deadline) throw new OrchestratorError(`Namespace ${ns} is still being deleted after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(this.pollIntervalMs);
    }
  }

  /**
   * Deletes every line of the account's namespace from the log store, with the
   * store's delete key (P-45), then checks that none is left. A deletion of the
   * same lines still running, from an earlier attempt, is waited for rather
   * than started again; one still running after `timeoutMs` throws.
   */
  async deleteLogs(accountId: string, timeoutMs = LOG_DELETION_TIMEOUT_MS): Promise<void> {
    const ns = accountNamespace(this.settings.namespacePrefix, accountId);
    const filter = namespaceFilter(ns);
    const key = await this.logStoreDeleteKey();
    const running = (await this.logStore.activeDeletions(key)).find((task) => task.filter === filter);
    const taskId = running?.task_id ?? (await this.logStore.startDeletion(filter, key));
    const deadline = Date.now() + timeoutMs;
    while ((await this.logStore.activeDeletions(key)).some((task) => task.task_id === taskId)) {
      if (Date.now() >= deadline) {
        throw new OrchestratorError(`Deleting the log lines of ${ns} is still running after ${Math.round(timeoutMs / 1000)} s (task ${taskId})`);
      }
      await sleep(this.pollIntervalMs);
    }
    if ((await this.logStore.query(`${filter} | limit 1 | fields _time`)).length > 0) {
      throw new OrchestratorError(`Log lines of ${ns} are still in the log store after their deletion (task ${taskId})`);
    }
  }

  /** The key, read each time from its file, so that a new one needs no restart. */
  private async logStoreDeleteKey(): Promise<string> {
    const file = this.settings.logStoreDeleteKeyFile;
    let key: string;
    try {
      key = (await readFile(file, 'utf8')).trim();
    } catch (error) {
      throw new OrchestratorError(`The log store's delete key can't be read from ${file}: ${describeError(error)}`);
    }
    if (!key) throw new OrchestratorError(`The log store's delete key file ${file} is empty`);
    return key;
  }

  async waitUntilReady(fn: FunctionWorkload, timeoutMs: number): Promise<void> {
    const deployment = await this.waitFor(fn, timeoutMs, isRolledOut);
    await this.collectEnvironments(fn, this.namespaceOf(fn), deployment);
  }

  /** For a cold start: one ready instance is enough to serve the call. */
  private async waitForAnInstance(fn: FunctionWorkload, timeoutMs: number): Promise<void> {
    await this.waitFor(fn, timeoutMs, (deployment) => (deployment.status?.readyReplicas ?? 0) >= 1);
  }

  /** Waits until `done` holds for the function's Deployment, and returns it as it was then. */
  private async waitFor(fn: FunctionWorkload, timeoutMs: number, done: (deployment: Deployment) => boolean): Promise<Deployment> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    const deadline = Date.now() + timeoutMs;
    let nextLoadCheck = Date.now() + this.loadCheckIntervalMs;
    let deployment: Deployment | null;
    for (;;) {
      deployment = await this.api.get<Deployment>(paths.apps(ns, 'deployments', name));
      if (!deployment) throw new OrchestratorError(`Deployment ${ns}/${name} does not exist`);
      if (done(deployment)) return deployment;
      if (Date.now() >= deadline) break;
      // Code that fails to load never becomes ready, and its runtime says so within a second:
      // waiting out the timeout would only keep the caller waiting for the same answer.
      if (Date.now() >= nextLoadCheck) {
        const loadError = await this.loadErrorSoFar(fn, ns, deployment);
        if (loadError) throw loadError;
        nextLoadCheck = Date.now() + this.loadCheckIntervalMs;
      }
      await sleep(this.pollIntervalMs);
    }
    const { details, loadError } = await this.diagnose(fn, ns, deployment);
    // The function's own error, which its owner may see; anything else is the platform's (D4).
    if (loadError) throw loadError;
    throw new OrchestratorError(
      `Function "${fn.name}" did not become ready within ${Math.round(timeoutMs / 1000)} s${details ? `: ${details}` : ''}`,
    );
  }

  /**
   * Why pods are not ready: container waiting reasons plus the newest pod's last
   * log lines, and the load error its runtime reported, if it did.
   */
  private async diagnose(
    fn: FunctionWorkload,
    ns: string,
    deployment: Deployment,
  ): Promise<{ details: string; loadError?: FunctionLoadError }> {
    try {
      const pods = await this.api.list<Pod>(paths.core(ns, 'pods'), `${LABELS.functionId}=${fn.id}`);
      if (pods.length === 0) {
        // Pods that cannot even be created (quota exceeded, unknown RuntimeClass) show up here.
        const failure = deployment.status?.conditions?.find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
        return {
          details: failure?.message
            ? `no pods were created: ${failure.message}`
            : 'no pods were created (check the tenant ResourceQuota and events)',
        };
      }
      const reasons = new Set<string>();
      for (const pod of pods) {
        for (const status of pod.status?.containerStatuses ?? []) {
          const waiting = status.state?.waiting;
          if (waiting?.reason) reasons.add(waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason);
          if (status.state?.terminated?.reason) reasons.add(`terminated: ${status.state.terminated.reason}`);
        }
        if (!pod.status?.containerStatuses?.length && pod.status?.phase) reasons.add(`pod ${pod.status.phase}`);
      }
      const log = await this.lastLines(fn, ns, newestOf(pods)!.metadata.name);
      return {
        details: [...reasons, log && `last log lines: ${log.split('\n').slice(-5).join(' | ')}`].filter(Boolean).join('; '),
        loadError: loadErrorIn(log),
      };
    } catch (err) {
      return { details: `diagnostics unavailable (${(err as Error).message})` };
    }
  }

  /** A page of the function's lines from the log store, in its account's namespace (P-43). */
  async logs(fn: FunctionWorkload, query: LogsQuery): Promise<FunctionLogsPage> {
    const rows = await this.logStore.query(pageQuery(this.namespaceOf(fn), fn.id, query));
    return toPage(rows, query.limit, query.cursor);
  }

  /** The function's lines as the log store gets them, in its account's namespace, until `signal` aborts (P-43). */
  tailLogs(fn: FunctionWorkload, filter: LogsFilter, signal: AbortSignal): AsyncIterable<FunctionLogLine> {
    const rows = this.logStore.tail(tailQuery(this.namespaceOf(fn), fn.id, filter), signal);
    return (async function* () {
      for await (const row of rows) yield toLine(row);
    })();
  }

  /**
   * A pod's last 20 lines of the past hour, from the log store, for the readiness
   * diagnosis. Best effort, as diagnostics are: '' when the store can't answer.
   */
  private async lastLines(fn: FunctionWorkload, ns: string, pod: string): Promise<string> {
    try {
      return await this.queryLastLines(fn, ns, pod);
    } catch (error) {
      this.logger.warn(`No log lines for the diagnosis of ${ns}/${pod}: ${(error as Error).message}`);
      return '';
    }
  }

  private async queryLastLines(fn: FunctionWorkload, ns: string, pod: string): Promise<string> {
    const rows = await this.logStore.query(
      `{namespace=${quoted(ns)}, function_id=${quoted(fn.id)}} pod:=${quoted(pod)} _time:1h | sort by (_time desc) limit 20 | fields _time, _msg`,
    );
    return rows
      .reverse()
      .map((row) => row._msg ?? '')
      .join('\n')
      .trim();
  }

  /**
   * The load error that the newest pod running the version being rolled out has
   * logged so far, while the wait goes on. Quiet when the pods or the log store
   * can't be read: the diagnosis at the deadline says so, once.
   */
  private async loadErrorSoFar(fn: FunctionWorkload, ns: string, deployment: Deployment): Promise<FunctionLoadError | undefined> {
    try {
      const pods = await this.api.list<Pod>(paths.core(ns, 'pods'), `${LABELS.functionId}=${fn.id}`);
      const newest = newestOf(pods.filter((pod) => runsTemplate(pod, deployment)));
      return newest && loadErrorIn(await this.queryLastLines(fn, ns, newest.metadata.name));
    } catch {
      return undefined;
    }
  }

  async scale(fn: FunctionWorkload, replicas: number): Promise<void> {
    // NaN would go out as "replicas": null, which Kubernetes takes as zero.
    if (!Number.isFinite(replicas)) throw new OrchestratorError(`Invalid replica count ${replicas} for function ${fn.id}`);
    await this.api.scaleDeployment(this.namespaceOf(fn), functionResourceName(fn.id), Math.max(0, Math.floor(replicas)));
  }

  /** The Deployment's desired and ready replicas, in one read; zeros when it doesn't exist. */
  private async instances(fn: FunctionWorkload): Promise<{ desired: number; ready: number }> {
    const deployment = await this.api.get<Deployment>(
      paths.apps(this.namespaceOf(fn), 'deployments', functionResourceName(fn.id)),
    );
    return { desired: deployment?.spec?.replicas ?? 0, ready: deployment?.status?.readyReplicas ?? 0 };
  }

  async readyInstances(fn: FunctionWorkload): Promise<number> {
    return (await this.instances(fn)).ready;
  }

  async desiredInstances(fn: FunctionWorkload): Promise<number> {
    return (await this.instances(fn)).desired;
  }

  async ping(timeoutMs: number): Promise<void> {
    // /version needs no more than a login: every ServiceAccount may read it.
    const { status } = await this.api.request('GET', '/version', { timeoutMs });
    if (status !== 200) throw new Error(`the API server answered ${status}`);
  }

  async readyInstancesByFunction(): Promise<Map<string, number>> {
    // One list of FF's Deployments in every namespace: a read the backend's ClusterRole allows (deploy/k8s/README.md).
    const deployments = await this.api.list<Deployment>(paths.allApps('deployments'), `${LABELS.managedBy}=${MANAGED_BY}`);
    const ready = new Map<string, number>();
    for (const deployment of deployments) {
      const functionId = deployment.metadata.labels?.[LABELS.functionId];
      const instances = deployment.status?.readyReplicas ?? 0;
      // Only FF's tenant namespaces: a label is easy to copy.
      if (!functionId || instances <= 0 || !deployment.metadata.namespace?.startsWith(this.settings.namespacePrefix)) continue;
      ready.set(functionId, instances);
    }
    return ready;
  }

  async invoke(fn: FunctionWorkload, payload: unknown, requestId?: string): Promise<InvokeResult> {
    let initMs: number | undefined;
    try {
      const { desired, ready } = await this.instances(fn);
      if (ready === 0) {
        // A cold start: how long it takes is recorded, even when it fails (D7 doesn't bill it).
        const waitStarted = Date.now();
        try {
          // Only raise from zero: an instance may already be starting, perhaps asked for by the
          // scaler for a burst of calls, and setting 1 here would take the others away again.
          if (desired === 0) {
            this.logger.log(`Cold start: scaling ${fn.id} from zero`);
            await this.scale(fn, 1);
          }
          await this.waitForAnInstance(fn, this.settings.readyTimeoutSeconds * 1000);
        } finally {
          initMs = Date.now() - waitStarted;
        }
      }
      return { ...this.toResult(await this.post(fn, payload, requestId)), ...(initMs !== undefined ? { initMs } : {}) };
    } catch (error) {
      throw withInitMs(error, initMs);
    }
  }

  private async post(fn: FunctionWorkload, payload: unknown, requestId?: string): Promise<KubeResponse> {
    const ns = this.namespaceOf(fn);
    const name = functionResourceName(fn.id);
    const body = JSON.stringify(payload);
    // The runtime logs the call under this ID, and answers with it (D6).
    const headers: Record<string, string> = requestId ? { [REQUEST_ID_HEADER]: requestId } : {};
    // A call may wait for a free instance (the runtime then answers 429), then runs up to its timeout. The
    // 2 s past that include the second the Node.js runtime may wait for the call's output (OUTPUT_WAIT_MS).
    const timeoutMs = maxQueueWaitMs(fn) + fn.timeout * 1000 + 2000;
    if (this.settings.invokeMode === 'proxy') {
      try {
        return await this.api.request('POST', paths.serviceProxy(ns, name, 'http', '/invoke'), { body, timeoutMs, headers });
      } catch (error) {
        // Giving up waiting is the same timeout in both modes, so development records what production does.
        if (error instanceof KubeRequestTimeoutError) throw noResponseWithin(timeoutMs);
        throw error;
      }
    }
    return postJson(`http://${name}.${ns}.svc:${RUNTIME_PORT}/invoke`, body, timeoutMs, headers);
  }

  private toResult(res: KubeResponse): InvokeResult {
    const parsed = (() => {
      try {
        return res.body ? (JSON.parse(res.body) as unknown) : null;
      } catch {
        return undefined;
      }
    })();
    // The runtime measures every call it ran, failed ones too: what D7 bills for errors and timeouts (P-20).
    const measured = { durationMs: measure(res.headers['x-ff-duration-ms']), memoryUsedMb: measure(res.headers['x-ff-max-memory-used-mb']) };
    if (res.status === 200 && parsed !== undefined) {
      return { output: parsed, ...measured };
    }
    const failure = runtimeError(parsed);
    if (failure) {
      if (failure.errorType === 'Sandbox.Timedout') throw new FunctionTimeoutError(failure.errorMessage, measured);
      if (res.headers['x-ff-function-error']) throw new FunctionRuntimeError(failure.errorType, failure.errorMessage, measured);
      // The runtime's queue: full, or no instance was free within one timeout.
      if (res.status === 429 && failure.errorType === 'TooManyRequestsException') throw new FunctionThrottledError(failure.errorMessage);
    }
    throw new OrchestratorError(`Invocation failed with HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
}

/**
 * The error the runtime logged when the function's code failed to load: its
 * last "function initialization failed" line (both runtimes log one, as JSON).
 */
export function loadErrorIn(log: string): FunctionLoadError | undefined {
  for (const line of log.split('\n').reverse()) {
    try {
      const entry = JSON.parse(line) as { msg?: unknown; errorType?: unknown; errorMessage?: unknown };
      if (entry?.msg === 'function initialization failed' && typeof entry.errorType === 'string') {
        return new FunctionLoadError(entry.errorType, typeof entry.errorMessage === 'string' ? entry.errorMessage : '');
      }
    } catch {
      // not a JSON line
    }
  }
  return undefined;
}

/** The runtime's error answer, { errorType, errorMessage }, when the body is one. */
function runtimeError(body: unknown): { errorType: string; errorMessage: string } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { errorType, errorMessage } = body as { errorType?: unknown; errorMessage?: unknown };
  if (typeof errorType !== 'string') return undefined;
  return { errorType, errorMessage: typeof errorMessage === 'string' ? errorMessage : '' };
}

/** The backend gave up waiting for the function's answer. */
function noResponseWithin(timeoutMs: number): FunctionTimeoutError {
  return new FunctionTimeoutError(`No response within ${timeoutMs} ms`);
}

/** A number the runtime measured, from its answer's header: 0 is a measure; a missing or garbled header is none. */
function measure(header: string | string[] | undefined): number | undefined {
  const text = Array.isArray(header) ? header[0] : header;
  if (text === undefined || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Direct (in-cluster) call to a function Service. */
function postJson(url: string, body: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<KubeResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(noResponseWithin(timeoutMs)));
    req.on('error', reject);
    req.end(body);
  });
}

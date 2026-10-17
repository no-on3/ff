import {
  CodeTooLargeError,
  FunctionLoadError,
  FunctionRuntimeError,
  FunctionThrottledError,
  FunctionTimeoutError,
  OrchestratorError,
} from '../orchestrator.errors';
import { KubeApi, KubeRequestTimeoutError, KubeResponse, RequestOptions } from './kube-client';
import { KubernetesOrchestrator, isRolledOut, loadErrorIn } from './kubernetes.orchestrator';
import { MAX_CODE_BYTES, TENANT_QUOTA_NAME } from './manifests';
import { functionResourceName, accountNamespace } from './naming';
import { settings, tenant, workload } from './test-fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
const rolledOut = (replicas: number) => ({
  metadata: { name: 'd', generation: 1 },
  spec: { replicas },
  status: { observedGeneration: 1, replicas, updatedReplicas: replicas, readyReplicas: replicas, availableReplicas: replicas },
});

/** In-memory stand-in for the API server. */
class FakeKubeApi implements KubeApi {
  objects = new Map<string, any>();
  lists = new Map<string, any[]>();
  applied: Array<{ path: string; manifest: any }> = [];
  deleted: string[] = [];
  deletedCollections: Array<{ path: string; selector: string }> = [];
  scaled: number[] = [];
  requests: Array<{ method: string; path: string; options?: RequestOptions }> = [];
  /** What request() answers next; an Error is thrown, as the client would. */
  responses: Array<KubeResponse | Error> = [];
  /** The function container's log, as the runtime writes it: one JSON object per line. */
  podLogText =
    '{"level":"info","msg":"runtime listening","port":8080}\n' +
    '{"level":"error","msg":"function initialization failed","errorType":"Runtime.ImportModuleError","errorMessage":"Cannot find module \'lodash\'"}';

  async apply<T>(path: string, manifest: object): Promise<T> {
    this.applied.push({ path, manifest });
    return manifest as T;
  }
  async get<T>(path: string): Promise<T | null> {
    return (this.objects.get(path) as T) ?? null;
  }
  async delete(path: string): Promise<boolean> {
    this.deleted.push(path);
    return true;
  }
  async deleteCollection(path: string, selector: string): Promise<void> {
    this.deletedCollections.push({ path, selector });
  }
  async scaleDeployment(namespace: string, name: string, replicas: number): Promise<void> {
    this.scaled.push(replicas);
    // Pretend the rollout completes immediately.
    this.objects.set(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`, rolledOut(replicas));
  }
  async list<T>(path: string): Promise<T[]> {
    return (this.lists.get(path) as T[]) ?? [];
  }
  async podLog(): Promise<string> {
    return this.podLogText;
  }
  async request(method: string, path: string, options?: RequestOptions): Promise<KubeResponse> {
    this.requests.push({ method, path, options });
    const next = this.responses.shift() ?? { status: 200, headers: {}, body: 'null' };
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('KubernetesOrchestrator', () => {
  const fn = workload();
  const ns = accountNamespace('ff-t-', fn.accountId);
  const name = functionResourceName(fn.id);
  const deploymentPath = `/apis/apps/v1/namespaces/${ns}/deployments/${name}`;
  let api: FakeKubeApi;
  let orchestrator: KubernetesOrchestrator;

  beforeEach(() => {
    api = new FakeKubeApi();
    orchestrator = new KubernetesOrchestrator(settings(), api, 5);
  });

  describe('deploy', () => {
    it('applies tenant guardrails first, then code, Service and Deployment', async () => {
      await orchestrator.deploy(fn, tenant());

      expect(api.applied.map((a) => a.manifest.kind)).toEqual([
        'Namespace',
        'ResourceQuota',
        'LimitRange',
        'NetworkPolicy',
        'ConfigMap',
        'Service',
        'Deployment',
      ]);
      expect(api.applied[0].path).toBe(`/api/v1/namespaces/${ns}`);
      expect(api.applied.every((a) => a.manifest.metadata.namespace === ns || a.manifest.kind === 'Namespace')).toBe(true);
    });

    it("sizes the namespace's quota from the account's plan (D5)", async () => {
      await orchestrator.deploy(fn, tenant({ pods: 7, cpu: '2', memory: '3Gi' }));

      const quota = api.applied.find((a) => a.manifest.kind === 'ResourceQuota')!;
      expect(quota.path).toBe(`/api/v1/namespaces/${ns}/resourcequotas/${TENANT_QUOTA_NAME}`);
      expect(quota.manifest.spec.hard).toMatchObject({
        pods: '7',
        'requests.cpu': '2',
        'limits.cpu': '2',
        'requests.memory': '3Gi',
        'limits.memory': '3Gi',
      });
    });

    it('starts new functions with max(1, minInstances) replicas', async () => {
      await orchestrator.deploy(workload({ minInstances: 0 }), tenant());
      await orchestrator.deploy(workload({ minInstances: 2 }), tenant());

      const replicas = api.applied.filter((a) => a.manifest.kind === 'Deployment').map((a) => a.manifest.spec.replicas);
      expect(replicas).toEqual([1, 2]);
    });

    it('rejects oversized code before touching the cluster', async () => {
      await expect(orchestrator.deploy(workload({ code: 'x'.repeat(MAX_CODE_BYTES + 1) }), tenant())).rejects.toBeInstanceOf(
        CodeTooLargeError,
      );
      expect(api.applied).toHaveLength(0);
    });
  });

  describe('applyTenantLimits: a plan change', () => {
    it("rewrites the quota of the account's namespace at once, and nothing else", async () => {
      api.objects.set(`/api/v1/namespaces/${ns}`, { metadata: { name: ns } });

      await orchestrator.applyTenantLimits(fn.accountId, tenant({ pods: 40, cpu: '16', memory: '16Gi' }));

      expect(api.applied.map((a) => a.path)).toEqual([`/api/v1/namespaces/${ns}/resourcequotas/${TENANT_QUOTA_NAME}`]);
      expect(api.applied[0].manifest.spec.hard).toMatchObject({ pods: '40', 'limits.cpu': '16', 'limits.memory': '16Gi' });
    });

    it("leaves an account without a namespace alone: its first function's deploy applies the plan", async () => {
      await orchestrator.applyTenantLimits(fn.accountId, tenant({ pods: 40 }));

      expect(api.applied).toEqual([]);
    });
  });

  describe('update', () => {
    it("writes the plan's quota again, so a plan change reaches the namespace with the next update", async () => {
      await orchestrator.update(fn, tenant({ pods: 9 }));

      expect(api.applied.find((a) => a.manifest.kind === 'ResourceQuota')!.manifest.spec.hard.pods).toBe('9');
    });

    it('keeps the current replica count, never going below minInstances', async () => {
      api.objects.set(deploymentPath, rolledOut(4));
      await orchestrator.update(fn, tenant());
      await orchestrator.update(workload({ minInstances: 6 }), tenant());

      const replicas = api.applied.filter((a) => a.manifest.kind === 'Deployment').map((a) => a.manifest.spec.replicas);
      expect(replicas).toEqual([4, 6]);
    });

    it('runs at least one replica for a function scaled to zero, so the wait checks a real pod', async () => {
      api.objects.set(deploymentPath, rolledOut(0));

      await orchestrator.update(fn, tenant());

      const deployment = api.applied.find((a) => a.manifest.kind === 'Deployment')!.manifest;
      expect(deployment.spec.replicas).toBe(1);
    });

    it('garbage-collects code ConfigMaps older than the current and previous versions', async () => {
      const cm = (n: string, ts: string) => ({ metadata: { name: n, creationTimestamp: ts } });
      await orchestrator.update(fn, tenant());
      const current = api.applied.find((a) => a.manifest.kind === 'ConfigMap')!.manifest.metadata.name;
      api.lists.set(`/api/v1/namespaces/${ns}/configmaps`, [
        cm(current, '2026-10-16T10:00:00Z'),
        cm('previous', '2026-10-16T09:00:00Z'),
        cm('older', '2026-10-16T08:00:00Z'),
        cm('oldest', '2026-10-16T07:00:00Z'),
      ]);
      api.deleted = [];

      await orchestrator.update(fn, tenant());

      expect(api.deleted).toEqual([
        `/api/v1/namespaces/${ns}/configmaps/older`,
        `/api/v1/namespaces/${ns}/configmaps/oldest`,
      ]);
    });
  });

  it('remove deletes the Deployment, the Service and every code ConfigMap', async () => {
    await orchestrator.remove(fn);

    expect(api.deleted).toEqual([deploymentPath, `/api/v1/namespaces/${ns}/services/${name}`]);
    expect(api.deletedCollections).toEqual([
      { path: `/api/v1/namespaces/${ns}/configmaps`, selector: `ff.dev/function-id=${fn.id}` },
    ]);
  });

  describe('waitUntilReady', () => {
    it('resolves once the rollout is complete', async () => {
      api.objects.set(deploymentPath, rolledOut(1));

      await expect(orchestrator.waitUntilReady(fn, 100)).resolves.toBeUndefined();
    });

    const crashLooping = () => {
      api.objects.set(deploymentPath, { ...rolledOut(1), status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 0 } });
      api.lists.set(`/api/v1/namespaces/${ns}/pods`, [
        {
          metadata: { name: 'fn-pod', creationTimestamp: '2026-10-16T10:00:00Z' },
          status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
        },
      ]);
    };

    it("fails with the function's own load error when its runtime logged one (P-10)", async () => {
      crashLooping();

      const error = await orchestrator.waitUntilReady(fn, 30).catch((err) => err);

      expect(error).toBeInstanceOf(FunctionLoadError);
      expect(error).toMatchObject({ errorType: 'Runtime.ImportModuleError', message: "Cannot find module 'lodash'" });
    });

    it('fails with the platform diagnostics when the runtime logged no load error', async () => {
      crashLooping();
      api.podLogText = '{"level":"info","msg":"runtime listening","port":8080}';

      const error = await orchestrator.waitUntilReady(fn, 30).catch((err) => err);

      expect(error).toBeInstanceOf(OrchestratorError);
      expect(error.message).toContain('did not become ready');
      expect(error.message).toContain('CrashLoopBackOff');
      expect(error.message).toContain('runtime listening');
    });

    it('reports why no pods could be created, e.g. an unknown RuntimeClass', async () => {
      const reason = 'pods "fn-x" is forbidden: pod rejected: RuntimeClass "gvisor" not found';
      api.objects.set(deploymentPath, {
        ...rolledOut(1),
        status: { observedGeneration: 1, conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: reason }] },
      });

      const error = await orchestrator.waitUntilReady(fn, 30).catch((err) => err);

      expect(error.message).toContain(`no pods were created: ${reason}`);
    });

    it('fails immediately when the Deployment does not exist', async () => {
      await expect(orchestrator.waitUntilReady(fn, 1000)).rejects.toThrow('does not exist');
    });
  });

  describe('invoke', () => {
    it('posts the payload through the API server proxy and maps the runtime headers', async () => {
      api.objects.set(deploymentPath, rolledOut(1));
      api.responses.push({
        status: 200,
        headers: { 'x-ff-duration-ms': '12.5', 'x-ff-max-memory-used-mb': '61' },
        body: '{"message":"hi"}',
      });

      const result = await orchestrator.invoke(fn, { a: 1 });

      expect(result).toEqual({ output: { message: 'hi' }, durationMs: 12.5, memoryUsedMb: 61 });
      expect(api.requests[0]).toMatchObject({
        method: 'POST',
        path: `/api/v1/namespaces/${ns}/services/${name}:http/proxy/invoke`,
        // One timeout of waiting for a free instance, then the run, plus a margin.
        options: { body: '{"a":1}', timeoutMs: 22_000 },
      });
      expect(api.scaled).toEqual([]);
    });

    it('cold-starts a function scaled to zero before invoking it', async () => {
      api.objects.set(deploymentPath, { ...rolledOut(0), status: { readyReplicas: 0 } });

      await orchestrator.invoke(fn, {});

      expect(api.scaled).toEqual([1]);
      expect(api.requests).toHaveLength(1);
    });

    it('waits for instances already starting, without scaling them back to one', async () => {
      // A burst asked for two instances; neither is ready yet.
      api.objects.set(deploymentPath, { ...rolledOut(2), status: { readyReplicas: 0 } });
      setTimeout(() => api.objects.set(deploymentPath, rolledOut(2)), 20);

      await orchestrator.invoke(fn, {});

      expect(api.scaled).toEqual([]);
      expect(api.requests).toHaveLength(1);
    });

    it('serves a cold start as soon as one instance is ready, not when all of them are', async () => {
      const starting = (ready: number) => ({
        metadata: { name: 'd', generation: 1 },
        spec: { replicas: 3 },
        status: { observedGeneration: 1, replicas: 3, updatedReplicas: 3, readyReplicas: ready, availableReplicas: ready },
      });
      api.objects.set(deploymentPath, starting(0));
      setTimeout(() => api.objects.set(deploymentPath, starting(1)), 20); // two of three still starting

      await orchestrator.invoke(fn, {});

      expect(api.requests).toHaveLength(1);
    });

    it.each([
      [504, { errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 10.00 seconds' }, { 'x-ff-function-error': 'Unhandled' }, FunctionTimeoutError],
      [500, { errorType: 'TypeError', errorMessage: 'bad input' }, { 'x-ff-function-error': 'Unhandled' }, FunctionRuntimeError],
      [503, { kind: 'Status', message: 'no endpoints available for service' }, {}, OrchestratorError],
      // The runtime's 429: its queue is full, or no instance was free within one timeout.
      [429, { errorType: 'TooManyRequestsException', errorMessage: 'Rate exceeded: no instance was free within 10.00 seconds' }, {}, FunctionThrottledError],
    ])('maps HTTP %i to the right error type', async (status, body, headers, errorClass) => {
      api.objects.set(deploymentPath, rolledOut(1));
      api.responses.push({ status, headers, body: JSON.stringify(body) });

      await expect(orchestrator.invoke(fn, {})).rejects.toBeInstanceOf(errorClass);
    });

    it('records giving up on a proxied call as a function timeout, as a direct call does', async () => {
      api.objects.set(deploymentPath, rolledOut(1));
      api.responses.push(new KubeRequestTimeoutError(22_000, 'POST', `/api/v1/namespaces/${ns}/services/${name}:http/proxy/invoke`));

      const error = await orchestrator.invoke(fn, {}).catch((err) => err);

      // The message of the direct mode, which postJson raises when its socket times out.
      expect(error).toBeInstanceOf(FunctionTimeoutError);
      expect(error).toMatchObject({ errorType: 'Sandbox.Timedout', message: 'No response within 22000 ms' });
    });

    it('passes other proxy failures on unchanged: only a timeout is a function timeout', async () => {
      api.objects.set(deploymentPath, rolledOut(1));
      const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6550'), { code: 'ECONNREFUSED' });
      api.responses.push(refused);

      await expect(orchestrator.invoke(fn, {})).rejects.toBe(refused);
    });

    it('keeps the runtime error type on FunctionRuntimeError', async () => {
      api.objects.set(deploymentPath, rolledOut(1));
      api.responses.push({ status: 500, headers: { 'x-ff-function-error': 'Unhandled' }, body: '{"errorType":"Runtime.OutOfMemory","errorMessage":"heap"}' });

      await expect(orchestrator.invoke(fn, {})).rejects.toMatchObject({ errorType: 'Runtime.OutOfMemory', message: 'heap' });
    });
  });

  it('scales through the scale subresource and reports ready replicas', async () => {
    await orchestrator.scale(fn, 3.7);
    api.objects.set(deploymentPath, rolledOut(2));

    expect(api.scaled).toEqual([3]);
    await expect(orchestrator.readyInstances(fn)).resolves.toBe(2);
  });

  it('refuses a replica count that is not a number, rather than sending null (which means zero)', async () => {
    await expect(orchestrator.scale(fn, Number.NaN)).rejects.toThrow('Invalid replica count NaN');
    await expect(orchestrator.update(workload({ minInstances: undefined as unknown as number }), tenant())).rejects.toThrow(
      'Invalid minInstances undefined',
    );
    expect(api.scaled).toEqual([]);
    expect(api.applied.filter((a) => a.manifest.kind === 'Deployment')).toEqual([]);
  });

  it('reports the desired replicas, ready or starting, and 0 without a Deployment', async () => {
    await expect(orchestrator.desiredInstances(fn)).resolves.toBe(0);
    api.objects.set(deploymentPath, { ...rolledOut(3), status: { readyReplicas: 1 } });

    await expect(orchestrator.desiredInstances(fn)).resolves.toBe(3);
    await expect(orchestrator.readyInstances(fn)).resolves.toBe(1);
  });

  describe('loadErrorIn', () => {
    it("finds the runtime's last load error among other log lines, Node.js or Python", () => {
      const log = [
        'not JSON',
        '{"level":"error","msg":"function initialization failed","errorType":"Old","errorMessage":"earlier attempt"}',
        '{"time": "2026-10-17T03:00:00Z", "level": "error", "msg": "function initialization failed", "errorType": "Runtime.UserCodeSyntaxError", "errorMessage": "invalid syntax (function.py, line 2)"}',
        '{"level":"info","msg":"shutting down"}',
      ].join('\n');

      expect(loadErrorIn(log)).toMatchObject({ errorType: 'Runtime.UserCodeSyntaxError', message: 'invalid syntax (function.py, line 2)' });
    });

    it('finds nothing in a log without one', () => {
      expect(loadErrorIn('')).toBeUndefined();
      expect(loadErrorIn('{"level":"error","msg":"function error","errorType":"TypeError"}')).toBeUndefined();
    });
  });

  describe('isRolledOut', () => {
    it.each([
      ['complete', rolledOut(2), true],
      ['controller has not observed the new generation', { ...rolledOut(1), metadata: { name: 'd', generation: 2 } }, false],
      ['old replicas still terminating', { ...rolledOut(1), status: { observedGeneration: 1, replicas: 2, updatedReplicas: 1, availableReplicas: 1 } }, false],
      ['new replica not available yet', { ...rolledOut(1), status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 0 } }, false],
      ['scaled to zero', rolledOut(0), true],
    ])('%s → %s', (_label, deployment, expected) => {
      expect(isRolledOut(deployment as any)).toBe(expected);
    });
  });
});

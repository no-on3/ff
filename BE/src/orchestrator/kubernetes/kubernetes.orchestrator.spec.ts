import { CodeTooLargeError, FunctionRuntimeError, FunctionTimeoutError, OrchestratorError } from '../orchestrator.errors';
import { KubeApi, KubeResponse, RequestOptions } from './kube-client';
import { KubernetesOrchestrator, isRolledOut } from './kubernetes.orchestrator';
import { MAX_CODE_BYTES } from './manifests';
import { functionResourceName, tenantNamespace } from './naming';
import { settings, workload } from './test-fixtures';

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
  responses: KubeResponse[] = [];

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
    return '{"level":"error","msg":"function initialization failed","errorType":"Runtime.ImportModuleError"}';
  }
  async request(method: string, path: string, options?: RequestOptions): Promise<KubeResponse> {
    this.requests.push({ method, path, options });
    return this.responses.shift() ?? { status: 200, headers: {}, body: 'null' };
  }
}

describe('KubernetesOrchestrator', () => {
  const fn = workload();
  const ns = tenantNamespace('ff-t-', fn.userId);
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
      await orchestrator.deploy(fn);

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

    it('starts new functions with max(1, minInstances) replicas', async () => {
      await orchestrator.deploy(workload({ minInstances: 0 }));
      await orchestrator.deploy(workload({ minInstances: 2 }));

      const replicas = api.applied.filter((a) => a.manifest.kind === 'Deployment').map((a) => a.manifest.spec.replicas);
      expect(replicas).toEqual([1, 2]);
    });

    it('rejects oversized code before touching the cluster', async () => {
      await expect(orchestrator.deploy(workload({ code: 'x'.repeat(MAX_CODE_BYTES + 1) }))).rejects.toBeInstanceOf(
        CodeTooLargeError,
      );
      expect(api.applied).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('keeps the current replica count, never going below minInstances', async () => {
      api.objects.set(deploymentPath, rolledOut(4));
      await orchestrator.update(fn);
      await orchestrator.update(workload({ minInstances: 6 }));

      const replicas = api.applied.filter((a) => a.manifest.kind === 'Deployment').map((a) => a.manifest.spec.replicas);
      expect(replicas).toEqual([4, 6]);
    });

    it('runs at least one replica for a function scaled to zero, so the wait checks a real pod', async () => {
      api.objects.set(deploymentPath, rolledOut(0));

      await orchestrator.update(fn);

      const deployment = api.applied.find((a) => a.manifest.kind === 'Deployment')!.manifest;
      expect(deployment.spec.replicas).toBe(1);
    });

    it('garbage-collects code ConfigMaps older than the current and previous versions', async () => {
      const cm = (n: string, ts: string) => ({ metadata: { name: n, creationTimestamp: ts } });
      await orchestrator.update(fn);
      const current = api.applied.find((a) => a.manifest.kind === 'ConfigMap')!.manifest.metadata.name;
      api.lists.set(`/api/v1/namespaces/${ns}/configmaps`, [
        cm(current, '2026-10-16T10:00:00Z'),
        cm('previous', '2026-10-16T09:00:00Z'),
        cm('older', '2026-10-16T08:00:00Z'),
        cm('oldest', '2026-10-16T07:00:00Z'),
      ]);
      api.deleted = [];

      await orchestrator.update(fn);

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

    it('fails with diagnostics when pods never become ready', async () => {
      api.objects.set(deploymentPath, { ...rolledOut(1), status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 0 } });
      api.lists.set(`/api/v1/namespaces/${ns}/pods`, [
        {
          metadata: { name: 'fn-pod', creationTimestamp: '2026-10-16T10:00:00Z' },
          status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
        },
      ]);

      const error = await orchestrator.waitUntilReady(fn, 30).catch((err) => err);

      expect(error).toBeInstanceOf(OrchestratorError);
      expect(error.message).toContain('did not become ready');
      expect(error.message).toContain('CrashLoopBackOff');
      expect(error.message).toContain('Runtime.ImportModuleError');
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
        options: { body: '{"a":1}', timeoutMs: 12_000 },
      });
      expect(api.scaled).toEqual([]);
    });

    it('cold-starts a function scaled to zero before invoking it', async () => {
      api.objects.set(deploymentPath, { ...rolledOut(0), status: { readyReplicas: 0 } });

      await orchestrator.invoke(fn, {});

      expect(api.scaled).toEqual([1]);
      expect(api.requests).toHaveLength(1);
    });

    it.each([
      [504, { errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 10.00 seconds' }, { 'x-ff-function-error': 'Unhandled' }, FunctionTimeoutError],
      [500, { errorType: 'TypeError', errorMessage: 'bad input' }, { 'x-ff-function-error': 'Unhandled' }, FunctionRuntimeError],
      [503, { kind: 'Status', message: 'no endpoints available for service' }, {}, OrchestratorError],
    ])('maps HTTP %i to the right error type', async (status, body, headers, errorClass) => {
      api.objects.set(deploymentPath, rolledOut(1));
      api.responses.push({ status, headers, body: JSON.stringify(body) });

      await expect(orchestrator.invoke(fn, {})).rejects.toBeInstanceOf(errorClass);
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

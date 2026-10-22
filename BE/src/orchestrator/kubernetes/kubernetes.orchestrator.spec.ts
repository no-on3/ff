import { Logger } from '@nestjs/common';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  FunctionLoadError,
  FunctionRuntimeError,
  FunctionThrottledError,
  FunctionTimeoutError,
  InvalidLogCursorError,
  LogStoreUnavailableError,
  OrchestratorError,
  initMsOf,
} from '../orchestrator.errors';
import { KubeApi, KubeRequestTimeoutError, KubeResponse, RequestOptions } from './kube-client';
import { KubernetesOrchestrator, isRolledOut, loadErrorIn } from './kubernetes.orchestrator';
import { StoredLine, decodeCursor, pageQuery, tailQuery } from './log-store';
import { BLOCKED_EGRESS_CIDRS, RUNTIME_PORT, TENANT_NETWORK_POLICY_NAME, TENANT_QUOTA_NAME } from './manifests';
import { ANNOTATIONS, LABELS, functionResourceName, accountNamespace } from './naming';
import { settings, tenant, workload } from './test-fixtures';

/* eslint-disable @typescript-eslint/no-explicit-any */
const rolledOut = (replicas: number) => ({
  metadata: { name: 'd', generation: 1 },
  spec: { replicas },
  status: { observedGeneration: 1, replicas, updatedReplicas: replicas, readyReplicas: replicas, availableReplicas: replicas },
});

/** Where the log store's queries go through the API server (P-43). */
const STORE_QUERY = '/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/select/logsql/query?';

/** A runtime's lines in the log store, newest first: started, then failed to load the code; or started only. */
const LISTENING: StoredLine = { _time: '2026-10-16T10:00:00Z', _msg: '{"level":"info","msg":"runtime listening","port":8080}' };
const LOAD_FAILED: StoredLine[] = [
  {
    _time: '2026-10-16T10:00:01Z',
    _msg: '{"level":"error","msg":"function initialization failed","errorType":"Runtime.ImportModuleError","errorMessage":"Cannot find module \'lodash\'"}',
  },
  LISTENING,
];

/** In-memory stand-in for the API server. */
class FakeKubeApi implements KubeApi {
  objects = new Map<string, any>();
  lists = new Map<string, any[]>();
  applied: Array<{ path: string; manifest: any }> = [];
  deleted: string[] = [];
  deletedCollections: Array<{ path: string; selector: string }> = [];
  listed: Array<{ path: string; selector: string }> = [];
  scaled: number[] = [];
  requests: Array<{ method: string; path: string; options?: RequestOptions }> = [];
  /** What request() answers next; an Error is thrown, as the client would. */
  responses: Array<KubeResponse | Error> = [];
  /**
   * The log store's answer to every query through its Service proxy (P-43): rows,
   * newest first, as it sorts them, or the rows for a given query; an Error is
   * thrown. By default, the runtime's lines when its code failed to load: one
   * JSON object per line.
   */
  storeRows: StoredLine[] | Error | ((query: string) => StoredLine[]) = LOAD_FAILED;
  storeQueries: string[] = [];

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
  async list<T>(path: string, selector: string): Promise<T[]> {
    this.listed.push({ path, selector });
    return (this.lists.get(path) as T[]) ?? [];
  }
  /** The store's live tail (P-43): what it sends, and the paths asked for. */
  tailText = '';
  streamed: string[] = [];
  async stream(path: string): Promise<{ status: number; body: Readable }> {
    this.streamed.push(path);
    return { status: 200, body: Readable.from([Buffer.from(this.tailText)], { objectMode: false }) };
  }
  async request(method: string, path: string, options?: RequestOptions): Promise<KubeResponse> {
    if (path.startsWith(STORE_QUERY)) {
      const query = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('query') ?? '';
      this.storeQueries.push(query);
      if (this.storeRows instanceof Error) throw this.storeRows;
      const rows = typeof this.storeRows === 'function' ? this.storeRows(query) : this.storeRows;
      return { status: 200, headers: {}, body: rows.map((row) => JSON.stringify(row)).join('\n') };
    }
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
    it('applies tenant guardrails first, then the Service and the Deployment, which mounts the code image', async () => {
      await orchestrator.deploy(fn, tenant());

      expect(api.applied.map((a) => a.manifest.kind)).toEqual(['Namespace', 'ResourceQuota', 'LimitRange', 'NetworkPolicy', 'Service', 'Deployment']);
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

    it("mounts the code's image, inline code's as a package's, and writes no ConfigMap", async () => {
      const image = 'ff-dev-registry:5000/ff-code/123456789012@sha256:' + 'e'.repeat(64);

      await orchestrator.deploy(workload({ codeImage: image }), tenant());

      const deployment = api.applied.find((a) => a.manifest.kind === 'Deployment')!.manifest;
      expect(deployment.spec.template.spec.volumes[0]).toEqual({ name: 'code', image: { reference: image, pullPolicy: 'IfNotPresent' } });
      expect(api.applied.some((a) => a.manifest.kind === 'ConfigMap')).toBe(false);
    });

    it('refuses a function without an image of its code before touching the cluster', async () => {
      await expect(orchestrator.deploy(workload({ codeImage: undefined }), tenant())).rejects.toThrow(`Function ${fn.id} has no code image`);
      expect(api.applied).toHaveLength(0);
    });
  });

  describe('applyTenantLimits: a plan change, or internet egress turned on or off', () => {
    const internetRule = (manifest: any) => manifest.spec.egress.some((rule: any) => rule.to?.[0]?.ipBlock?.cidr === '0.0.0.0/0');

    it("rewrites the quota and the NetworkPolicy of the account's namespace at once, and nothing else", async () => {
      api.objects.set(`/api/v1/namespaces/${ns}`, { metadata: { name: ns } });

      await orchestrator.applyTenantLimits(fn.accountId, tenant({ pods: 40, cpu: '16', memory: '16Gi' }, true));
      await orchestrator.applyTenantLimits(fn.accountId, tenant({ pods: 40, cpu: '16', memory: '16Gi' }, false));

      expect(api.applied.map((a) => a.path)).toEqual([
        `/api/v1/namespaces/${ns}/resourcequotas/${TENANT_QUOTA_NAME}`,
        `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${TENANT_NETWORK_POLICY_NAME}`,
        `/api/v1/namespaces/${ns}/resourcequotas/${TENANT_QUOTA_NAME}`,
        `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${TENANT_NETWORK_POLICY_NAME}`,
      ]);
      expect(api.applied[0].manifest.spec.hard).toMatchObject({ pods: '40', 'limits.cpu': '16', 'limits.memory': '16Gi' });
      expect([internetRule(api.applied[1].manifest), internetRule(api.applied[3].manifest)]).toEqual([true, false]);
    });

    it("leaves an account without a namespace alone: its first function's deploy applies the plan", async () => {
      await orchestrator.applyTenantLimits(fn.accountId, tenant({ pods: 40 }));

      expect(api.applied).toEqual([]);
    });
  });

  describe('update', () => {
    it("writes the plan's quota and the account's internet egress again, so a change reaches the namespace with the next update", async () => {
      await orchestrator.update(fn, tenant({ pods: 9 }, true));

      expect(api.applied.find((a) => a.manifest.kind === 'ResourceQuota')!.manifest.spec.hard.pods).toBe('9');
      expect(api.applied.find((a) => a.manifest.kind === 'NetworkPolicy')!.manifest.spec.egress).toContainEqual({
        to: [{ ipBlock: { cidr: '0.0.0.0/0', except: BLOCKED_EGRESS_CIDRS } }],
      });
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

    it('keeps the code ConfigMap the replaced version mounts, from before code came as an image, and deletes the others', async () => {
      const cm = (n: string) => ({ metadata: { name: n, creationTimestamp: '2026-10-21T09:00:00Z' } });
      api.lists.set(`/api/v1/namespaces/${ns}/configmaps`, [cm('fn-x-inline-now'), cm('fn-x-inline-before')]);
      api.objects.set(deploymentPath, {
        ...rolledOut(1),
        spec: { replicas: 1, template: { spec: { volumes: [{ name: 'code', configMap: { name: 'fn-x-inline-now' } }] } } },
      });

      await orchestrator.update(fn, tenant());

      expect(api.deleted).toEqual([`/api/v1/namespaces/${ns}/configmaps/fn-x-inline-before`]);
    });

    it('deletes the last code ConfigMap at the next rollout, once no pod mounts any', async () => {
      api.lists.set(`/api/v1/namespaces/${ns}/configmaps`, [{ metadata: { name: 'fn-x-inline-now' } }]);
      api.objects.set(deploymentPath, rolledOut(1));

      await orchestrator.update(fn, tenant());

      expect(api.deleted).toEqual([`/api/v1/namespaces/${ns}/configmaps/fn-x-inline-now`]);
    });
  });

  describe("the function's variables and secrets", () => {
    const secretPath = (slot: number) => `/api/v1/namespaces/${ns}/secrets/${name}-env-${slot}`;
    const withEnvironment = (revision: string, values: Record<string, string> = { DB_PASSWORD: 'hunter2' }) =>
      workload({ environment: { revision, values } });
    const applied = (kind: string) => api.applied.filter((a) => a.manifest.kind === kind);
    const lastDeployment = () => applied('Deployment').at(-1)!.manifest;
    /** The Deployment as the cluster now has it, rolled out. */
    const rollOut = () => api.objects.set(deploymentPath, { ...lastDeployment(), ...rolledOut(1), spec: { ...lastDeployment().spec, replicas: 1 } });

    it('writes them into the first Secret before the Deployment, which reads it through envFrom', async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());

      expect(api.applied.map((a) => a.manifest.kind).slice(-2)).toEqual(['Secret', 'Deployment']);
      expect(applied('Secret')[0].path).toBe(secretPath(0));
      expect(lastDeployment().spec.template.spec.containers[0].envFrom).toEqual([{ secretRef: { name: `${name}-env-0` } }]);
    });

    it('keeps an unchanged environment where it is, written again', async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());
      rollOut();

      await orchestrator.update({ ...withEnvironment('r1'), code: 'export const handler = async () => 2;' }, tenant());

      expect(applied('Secret').map((a) => a.path)).toEqual([secretPath(0), secretPath(0)]);
    });

    it("writes a new environment into the Secret the running version doesn't read, so its pods keep theirs", async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());
      rollOut();
      await orchestrator.update(withEnvironment('r2', { DB_PASSWORD: 'new' }), tenant());
      rollOut();
      await orchestrator.update(withEnvironment('r3', { DB_PASSWORD: 'newer' }), tenant());

      expect(applied('Secret').map((a) => a.path)).toEqual([secretPath(0), secretPath(1), secretPath(0)]);
      expect(lastDeployment().spec.template.spec.containers[0].envFrom).toEqual([{ secretRef: { name: `${name}-env-0` } }]);
    });

    it('deletes the Secret no pod reads once the rollout is complete, and never the one in use', async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());
      rollOut();
      await orchestrator.update(withEnvironment('r2', { DB_PASSWORD: 'new' }), tenant());
      rollOut();
      api.deleted = [];

      await orchestrator.waitUntilReady(withEnvironment('r2'), 100);

      expect(api.deleted).toEqual([secretPath(0)]);
    });

    it('deletes both once the function has none any more, and writes no Secret for it', async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());
      rollOut();
      await orchestrator.update(fn, tenant());
      rollOut();
      api.deleted = [];

      await orchestrator.waitUntilReady(fn, 100);

      expect(applied('Secret')).toHaveLength(1);
      expect(lastDeployment().spec.template.spec.containers[0].envFrom).toBeUndefined();
      expect(api.deleted).toEqual([secretPath(0), secretPath(1)]);
    });

    it('keeps both while a rollout fails: a rollback needs the old values', async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());
      api.objects.set(deploymentPath, { ...lastDeployment(), status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 0 } });
      api.deleted = [];

      await expect(orchestrator.waitUntilReady(withEnvironment('r1'), 30)).rejects.toThrow();

      expect(api.deleted).toEqual([]);
    });

    it('says only that a Secret could not be deleted, and the wait still succeeds', async () => {
      await orchestrator.deploy(withEnvironment('r1'), tenant());
      rollOut();
      api.delete = async () => {
        throw new Error('forbidden');
      };
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await expect(orchestrator.waitUntilReady(withEnvironment('r1'), 100)).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(`Could not delete the unused environment Secret ${ns}/${name}-env-1: forbidden`);
      warn.mockRestore();
    });
  });

  it('remove deletes the Deployment, the Service, every code ConfigMap, and both environment Secrets by name', async () => {
    await orchestrator.remove(fn);

    expect(api.deleted).toEqual([
      deploymentPath,
      `/api/v1/namespaces/${ns}/services/${name}`,
      `/api/v1/namespaces/${ns}/secrets/${name}-env-0`,
      `/api/v1/namespaces/${ns}/secrets/${name}-env-1`,
    ]);
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

    it("reads the newest pod's last lines from the log store, in its account's namespace (P-43)", async () => {
      crashLooping();

      await orchestrator.waitUntilReady(fn, 30).catch(() => undefined);

      expect(api.storeQueries).toEqual([
        `{namespace="${ns}", function_id="${fn.id}"} pod:="fn-pod" _time:1h | sort by (_time desc) limit 20 | fields _time, _msg`,
      ]);
    });

    it('fails with the platform diagnostics when the runtime logged no load error', async () => {
      crashLooping();
      api.storeRows = [LISTENING];

      const error = await orchestrator.waitUntilReady(fn, 30).catch((err) => err);

      expect(error).toBeInstanceOf(OrchestratorError);
      expect(error.message).toContain('did not become ready');
      expect(error.message).toContain('CrashLoopBackOff');
      expect(error.message).toContain('runtime listening');
    });

    it("still says why without the log store: the pods' state, and no load error", async () => {
      crashLooping();
      api.storeRows = new Error('connect ECONNREFUSED');

      const error = await orchestrator.waitUntilReady(fn, 30).catch((err) => err);

      expect(error).toBeInstanceOf(OrchestratorError);
      expect(error).not.toBeInstanceOf(FunctionLoadError);
      expect(error.message).toContain('CrashLoopBackOff');
      expect(error.message).not.toContain('last log lines');
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

    describe('code that fails to load, reported while waiting rather than at the deadline', () => {
      const podsPath = `/api/v1/namespaces/${ns}/pods`;
      const version = (code: string, runtime: string = fn.runtime) => ({
        labels: { [LABELS.runtime]: runtime },
        annotations: { [ANNOTATIONS.codeSha256]: code },
      });
      /** The Deployment rolling out `code`, its pods not ready yet. */
      const rollingOut = (code: string) => ({
        ...rolledOut(1),
        spec: { replicas: 1, template: { metadata: version(code) } },
        status: { observedGeneration: 1, replicas: 2, updatedReplicas: 1, availableReplicas: 0 },
      });
      const runningPod = (name: string, created: string, code: string, runtime?: string) => ({
        metadata: { name, creationTimestamp: created, ...version(code, runtime) },
        status: { phase: 'Running', containerStatuses: [{ ready: false, state: { running: {} } }] },
      });

      it('fails as soon as the log store has the load error, long before the timeout', async () => {
        orchestrator = new KubernetesOrchestrator(settings(), api, 5, 20);
        api.objects.set(deploymentPath, rollingOut('v2'));
        api.lists.set(podsPath, [runningPod('fn-v2', '2026-10-21T00:00:01Z', 'v2')]);

        const started = Date.now();
        const error = await orchestrator.waitUntilReady(fn, 60_000).catch((err) => err);

        expect(error).toBeInstanceOf(FunctionLoadError);
        expect(error).toMatchObject({ errorType: 'Runtime.ImportModuleError' });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(api.storeQueries[0]).toContain('pod:="fn-v2"');
      });

      it("keeps waiting when only pods of another version logged one, as a rollback's wait must", async () => {
        orchestrator = new KubernetesOrchestrator(settings(), api, 5, 5);
        // Rolling back to v1: the failed v2 pod, and one with v1's code on another runtime, are newer than v1's.
        api.objects.set(deploymentPath, rollingOut('v1'));
        api.lists.set(podsPath, [
          runningPod('fn-v1', '2026-10-21T00:00:00Z', 'v1'),
          runningPod('fn-v2', '2026-10-21T00:00:05Z', 'v2'),
          runningPod('fn-v1-python', '2026-10-21T00:00:09Z', 'v1', 'python'),
        ]);
        api.storeRows = (query) => (query.includes('pod:="fn-v1"') ? [LISTENING] : LOAD_FAILED);
        setTimeout(() => api.objects.set(deploymentPath, rolledOut(1)), 150);

        await expect(orchestrator.waitUntilReady(fn, 5_000)).resolves.toBeUndefined();
        expect(api.storeQueries.length).toBeGreaterThan(0);
        expect(api.storeQueries.every((query) => query.includes('pod:="fn-v1"'))).toBe(true);
      });

      it("doesn't warn at every look while the log store can't answer: once, at the deadline", async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
          orchestrator = new KubernetesOrchestrator(settings(), api, 5, 5);
          api.objects.set(deploymentPath, rollingOut('v2'));
          api.lists.set(podsPath, [runningPod('fn-v2', '2026-10-21T00:00:01Z', 'v2')]);
          api.storeRows = new Error('connect ECONNREFUSED');

          const error = await orchestrator.waitUntilReady(fn, 200).catch((err) => err);

          expect(error).toBeInstanceOf(OrchestratorError);
          expect(error).not.toBeInstanceOf(FunctionLoadError);
          expect(api.storeQueries.length).toBeGreaterThan(2);
          expect(warn.mock.calls.filter(([message]) => String(message).startsWith('No log lines'))).toHaveLength(1);
        } finally {
          warn.mockRestore();
        }
      });
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

    describe('what usage records need (P-20)', () => {
      /** Starting instances that become ready after `ms`: a cold start of about that long. */
      const readyAfter = (ms: number) => {
        api.objects.set(deploymentPath, { ...rolledOut(2), status: { readyReplicas: 0 } });
        setTimeout(() => api.objects.set(deploymentPath, rolledOut(2)), ms);
      };

      it("sends the invocation's ID to the runtime as X-FF-Request-Id, and nothing without one (D6)", async () => {
        api.objects.set(deploymentPath, rolledOut(1));

        await orchestrator.invoke(fn, {}, 'inv-1');
        await orchestrator.invoke(fn, {});

        expect(api.requests.map((request) => request.options?.headers)).toEqual([{ 'x-ff-request-id': 'inv-1' }, {}]);
      });

      it("sends it on a direct call to the function's Service too, and reads a measure of 0 ms as one", async () => {
        // A local server stands in for the Service; the request still names the Service's address.
        const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
        const server = http.createServer((req, res) => {
          let body = '';
          req.on('data', (chunk: Buffer) => (body += chunk.toString()));
          req.on('end', () => {
            seen.push({ url: req.url, headers: req.headers, body });
            res.writeHead(200, { 'content-type': 'application/json', 'x-ff-duration-ms': '0.00', 'x-ff-max-memory-used-mb': '48' });
            res.end('"ok"');
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as AddressInfo;
        const send = http.request;
        const urls: string[] = [];
        const spy = jest.spyOn(http, 'request').mockImplementation((url: string, options: http.RequestOptions, callback: () => void) => {
          urls.push(url);
          return send(`http://127.0.0.1:${port}${new URL(url).pathname}`, options, callback);
        });
        try {
          const direct = new KubernetesOrchestrator(settings({ invokeMode: 'direct' }), api, 5);
          api.objects.set(deploymentPath, rolledOut(1));

          const result = await direct.invoke(fn, { a: 1 }, 'inv-2');

          expect(urls).toEqual([`http://${name}.${ns}.svc:${RUNTIME_PORT}/invoke`]);
          expect(seen).toEqual([
            { url: '/invoke', headers: expect.objectContaining({ 'x-ff-request-id': 'inv-2', 'content-type': 'application/json' }), body: '{"a":1}' },
          ]);
          // 0.00 ms is what the runtime measured: billed as such, not replaced by the backend's own, longer measure.
          expect(result).toEqual({ output: 'ok', durationMs: 0, memoryUsedMb: 48 });
        } finally {
          spy.mockRestore();
          await new Promise((resolve) => server.close(resolve));
        }
      });

      it('keeps what the runtime measured of a call that failed: its duration and memory', async () => {
        api.objects.set(deploymentPath, rolledOut(1));
        const measured = { 'x-ff-function-error': 'Unhandled', 'x-ff-duration-ms': '41.25', 'x-ff-max-memory-used-mb': '77' };
        api.responses.push(
          { status: 500, headers: measured, body: '{"errorType":"TypeError","errorMessage":"bad input"}' },
          {
            status: 504,
            headers: { ...measured, 'x-ff-duration-ms': '5003.10' },
            body: '{"errorType":"Sandbox.Timedout","errorMessage":"Task timed out after 5.00 seconds"}',
          },
          { status: 500, headers: { 'x-ff-function-error': 'Unhandled', 'x-ff-duration-ms': 'soon' }, body: '{"errorType":"Error","errorMessage":"x"}' },
        );

        const failures: unknown[] = [];
        for (let i = 0; i < 3; i++) failures.push(await orchestrator.invoke(fn, {}).catch((error: unknown) => error));

        expect(failures[0]).toBeInstanceOf(FunctionRuntimeError);
        expect(failures[0]).toMatchObject({ errorType: 'TypeError', durationMs: 41.25, memoryUsedMb: 77 });
        expect(failures[1]).toBeInstanceOf(FunctionTimeoutError);
        expect(failures[1]).toMatchObject({ durationMs: 5003.1, memoryUsedMb: 77 });
        // A garbled or missing header is no measure: the backend then times the call itself.
        expect(failures[2]).toMatchObject({ durationMs: undefined, memoryUsedMb: undefined });
      });

      it('reports how long a cold start took, and no cold start for a warm call', async () => {
        readyAfter(40);

        const cold = await orchestrator.invoke(fn, {});
        const warm = await orchestrator.invoke(fn, {});

        expect(cold.initMs).toBeGreaterThanOrEqual(35);
        expect(cold.initMs).toBeLessThan(5_000);
        expect(warm).not.toHaveProperty('initMs');
      });

      it('marks a failure after a cold start with how long the cold start took, and one without a cold start with nothing', async () => {
        readyAfter(40);
        const boom = { status: 500, headers: { 'x-ff-function-error': 'Unhandled' }, body: '{"errorType":"Error","errorMessage":"boom"}' };
        api.responses.push(boom, boom);

        const afterColdStart = await orchestrator.invoke(fn, {}).catch((error: unknown) => error);
        const warm = await orchestrator.invoke(fn, {}).catch((error: unknown) => error);

        expect(afterColdStart).toBeInstanceOf(FunctionRuntimeError);
        expect(initMsOf(afterColdStart)).toBeGreaterThanOrEqual(35);
        expect(warm).toBeInstanceOf(FunctionRuntimeError);
        expect(initMsOf(warm)).toBeUndefined();
      });

      it('marks a cold start that never became ready with how long it waited, and never calls the function', async () => {
        const impatient = new KubernetesOrchestrator(settings({ readyTimeoutSeconds: 0.05 }), api, 5);
        api.objects.set(deploymentPath, { ...rolledOut(2), status: { readyReplicas: 0 } }); // stays so

        const error = await impatient.invoke(fn, {}).catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(OrchestratorError);
        expect(initMsOf(error)).toBeGreaterThanOrEqual(50);
        expect(api.requests).toEqual([]);
      });
    });
  });

  describe('removeTenant: closing an account (P-45)', () => {
    const nsPath = `/api/v1/namespaces/${ns}`;
    /** The namespace answers GET `times` more times once deleted, then is gone. */
    const goneAfter = (times: number) => {
      const get = api.get.bind(api);
      let left = times;
      api.get = async <T>(path: string): Promise<T | null> => {
        if (path === nsPath && api.deleted.includes(nsPath) && left-- <= 0) api.objects.delete(nsPath);
        return get<T>(path);
      };
    };

    it("deletes the account's namespace, and returns once it is gone", async () => {
      api.objects.set(nsPath, { metadata: { name: ns }, status: { phase: 'Active' } });
      goneAfter(2);

      await orchestrator.removeTenant(fn.accountId);

      expect(api.deleted).toEqual([nsPath]);
      expect(api.objects.has(nsPath)).toBe(false);
    });

    it('asks nothing more of an account without a namespace', async () => {
      await orchestrator.removeTenant(fn.accountId);

      expect(api.deleted).toEqual([]);
    });

    it('only waits for a namespace being deleted already', async () => {
      api.objects.set(nsPath, { metadata: { name: ns }, status: { phase: 'Terminating' } });
      let gets = 0;
      const get = api.get.bind(api);
      api.get = async <T>(path: string): Promise<T | null> => {
        if (path === nsPath && ++gets === 3) api.objects.delete(nsPath);
        return get<T>(path);
      };

      await orchestrator.removeTenant(fn.accountId);

      expect(api.deleted).toEqual([]);
      expect(gets).toBe(3);
    });

    it('fails when the namespace is still there after the timeout: the next attempt waits again', async () => {
      api.objects.set(nsPath, { metadata: { name: ns }, status: { phase: 'Active' } });

      await expect(orchestrator.removeTenant(fn.accountId, 20)).rejects.toThrow(new OrchestratorError(`Namespace ${ns} is still being deleted after 0 s`));
    });
  });

  describe("deleteLogs: closing an account's log lines (P-45)", () => {
    const STORE = '/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/delete/';
    const FILTER = `{namespace="${ns}"}`;
    const ok = (body: unknown): KubeResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });
    const keyFile = (key: string) => {
      const file = join(mkdtempSync(join(tmpdir(), 'ff-p45-')), 'key');
      writeFileSync(file, key);
      return file;
    };
    const asked = () => api.requests.map(({ method, path, options }) => [method, path.replace(STORE, ''), Object.fromEntries(new URLSearchParams(options?.body ?? ''))]);

    beforeEach(() => {
      orchestrator = new KubernetesOrchestrator(settings({ logStoreDeleteKeyFile: keyFile('the-key\n') }), api, 5);
      api.storeRows = [];
    });

    it("deletes the namespace's lines with the key from its file, waits for the task, and checks that none is left", async () => {
      api.responses = [ok([]), ok({ task_id: 't-1' }), ok([{ task_id: 't-1', filter: FILTER }]), ok([{ task_id: 'other', filter: '{namespace="ff-t-x"}' }])];

      await orchestrator.deleteLogs(fn.accountId);

      expect(asked()).toEqual([
        ['POST', 'active_tasks', { authKey: 'the-key' }],
        ['POST', 'run_task', { filter: FILTER, authKey: 'the-key' }],
        ['POST', 'active_tasks', { authKey: 'the-key' }],
        ['POST', 'active_tasks', { authKey: 'the-key' }],
      ]);
      expect(api.storeQueries).toEqual([`${FILTER} | limit 1 | fields _time`]);
    });

    it('waits for a deletion of the same lines still running from an earlier attempt, rather than starting another', async () => {
      api.responses = [ok([{ task_id: 'earlier', filter: FILTER }]), ok([{ task_id: 'earlier', filter: FILTER }]), ok([])];

      await orchestrator.deleteLogs(fn.accountId);

      expect(asked().map(([, path]) => path)).toEqual(['active_tasks', 'active_tasks', 'active_tasks']);
    });

    it('reads the key again each time, so that a new one needs no restart', async () => {
      const file = keyFile('first');
      orchestrator = new KubernetesOrchestrator(settings({ logStoreDeleteKeyFile: file }), api, 5);
      api.responses = [ok([]), ok({ task_id: 't-1' }), ok([])];
      await orchestrator.deleteLogs(fn.accountId);
      writeFileSync(file, 'second');
      api.responses = [ok([]), ok({ task_id: 't-2' }), ok([])];

      await orchestrator.deleteLogs(fn.accountId);

      expect(asked().map(([, , form]) => (form as Record<string, string>).authKey)).toEqual(['first', 'first', 'first', 'second', 'second', 'second']);
    });

    it('fails when lines are left after the task, or the task is still running after the timeout: the next attempt tries again', async () => {
      api.responses = [ok([]), ok({ task_id: 't-1' }), ok([])];
      api.storeRows = [{ _time: '2026-10-18T10:00:00Z' }];
      await expect(orchestrator.deleteLogs(fn.accountId)).rejects.toThrow(new OrchestratorError(`Log lines of ${ns} are still in the log store after their deletion (task t-1)`));

      api.responses = [ok([]), ok({ task_id: 't-2' }), ...Array.from({ length: 50 }, () => ok([{ task_id: 't-2', filter: FILTER }]))];
      await expect(orchestrator.deleteLogs(fn.accountId, 20)).rejects.toThrow(
        new OrchestratorError(`Deleting the log lines of ${ns} is still running after 0 s (task t-2)`),
      );
    });

    it("fails, naming the file, when the key can't be read or is empty, and then asks the store nothing", async () => {
      const missing = new KubernetesOrchestrator(settings({ logStoreDeleteKeyFile: '/nonexistent/key' }), api, 5);
      const empty = new KubernetesOrchestrator(settings({ logStoreDeleteKeyFile: keyFile(' \n') }), api, 5);

      await expect(missing.deleteLogs(fn.accountId)).rejects.toThrow(/^The log store's delete key can't be read from \/nonexistent\/key: .*ENOENT/);
      await expect(empty.deleteLogs(fn.accountId)).rejects.toThrow(/^The log store's delete key file .* is empty$/);
      expect(api.requests).toEqual([]);
    });

    it("passes on the store's refusal: a key it doesn't take", async () => {
      api.responses = [{ status: 401, headers: {}, body: "The provided authKey doesn't match -deleteAuthKey" }];

      await expect(orchestrator.deleteLogs(fn.accountId)).rejects.toThrow(new LogStoreUnavailableError("The log store answered 401: The provided authKey doesn't match -deleteAuthKey"));
    });
  });

  describe('logs (P-43)', () => {
    const window = { start: new Date('2026-10-17T10:00:00Z'), end: new Date('2026-10-17T11:00:00Z'), limit: 2 };

    it("asks the log store for a page of the function's lines in its account's namespace, through the API server's proxy", async () => {
      api.storeRows = [
        { _time: '2026-10-17T10:00:03Z', _msg: 'third', pod: 'fn-a', stream: 'stdout', request_id: 'req-1' },
        { _time: '2026-10-17T10:00:02Z', _msg: 'second', pod: 'fn-b', stream: 'stderr' },
        { _time: '2026-10-17T10:00:01Z', _msg: 'first', pod: 'fn-a', stream: 'stdout' },
      ];

      const page = await orchestrator.logs(fn, { ...window, q: 'time out', requestId: 'req-1' });

      expect(api.storeQueries).toEqual([pageQuery(ns, fn.id, { ...window, q: 'time out', requestId: 'req-1' })]);
      expect(api.storeQueries[0]).toContain(`{namespace="${ns}", function_id="${fn.id}"}`);
      expect(page.lines).toEqual([
        { time: '2026-10-17T10:00:02.000000000Z', instance: 'fn-b', requestId: null, stream: 'stderr', message: 'second' },
        { time: '2026-10-17T10:00:03.000000000Z', instance: 'fn-a', requestId: 'req-1', stream: 'stdout', message: 'third' },
      ]);
      expect(decodeCursor(page.next!)).toEqual({ before: '2026-10-17T10:00:02Z', skip: 1 });
    });

    it('gives no lines and no cursor for a function the store has nothing of', async () => {
      api.storeRows = [];

      expect(await orchestrator.logs(fn, window)).toEqual({ lines: [], next: null });
    });

    it("tails the function's lines in its account's namespace, as lines (P-43)", async () => {
      api.tailText = '{"_time":"2026-10-17T10:00:01Z","_msg":"live","pod":"fn-a","stream":"stderr","request_id":"req-1"}\n';

      const lines: unknown[] = [];
      for await (const line of orchestrator.tailLogs(fn, { requestId: 'req-1' }, new AbortController().signal)) lines.push(line);

      const [route, search] = api.streamed[0].split('?');
      expect(route).toBe('/api/v1/namespaces/ff-system/services/victoria-logs:9428/proxy/select/logsql/tail');
      expect(new URLSearchParams(search).get('query')).toBe(tailQuery(ns, fn.id, { requestId: 'req-1' }));
      expect(lines).toEqual([{ time: '2026-10-17T10:00:01.000000000Z', instance: 'fn-a', requestId: 'req-1', stream: 'stderr', message: 'live' }]);
    });

    it('rejects with the store unavailable when it fails, and with the cursor when no page gave it', async () => {
      api.storeRows = new Error('connect ECONNREFUSED');
      await expect(orchestrator.logs(fn, window)).rejects.toBeInstanceOf(LogStoreUnavailableError);

      await expect(orchestrator.logs(fn, { ...window, cursor: 'bm9wZQ' })).rejects.toBeInstanceOf(InvalidLogCursorError);
    });
  });

  describe('readyInstancesByFunction: capacity samples (P-21)', () => {
    const deployment = (namespace: string, labels: Record<string, string>, readyReplicas?: number) => ({
      metadata: { name: 'fn-x', namespace, labels },
      status: readyReplicas === undefined ? {} : { readyReplicas },
    });
    const ff = (functionId: string) => ({ 'app.kubernetes.io/managed-by': 'ff-controller', 'ff.dev/function-id': functionId });

    it("lists FF's Deployments in every namespace in one call, and counts each function's ready instances", async () => {
      api.lists.set('/apis/apps/v1/deployments', [
        deployment('ff-t-aaaaaaaaaaaa', ff('f-two'), 2),
        deployment('ff-t-bbbbbbbbbbbb', ff('f-one'), 1),
        deployment('ff-t-aaaaaaaaaaaa', ff('f-starting'), 0), // its pod isn't ready yet
        deployment('ff-t-aaaaaaaaaaaa', ff('f-zero')), // scaled to zero: no ready count at all
      ]);

      const ready = await orchestrator.readyInstancesByFunction();

      expect(api.listed).toEqual([{ path: '/apis/apps/v1/deployments', selector: 'app.kubernetes.io/managed-by=ff-controller' }]);
      expect(Object.fromEntries(ready)).toEqual({ 'f-two': 2, 'f-one': 1 });
    });

    it("leaves out a Deployment outside FF's tenant namespaces, or without a function ID, whatever its labels say", async () => {
      api.lists.set('/apis/apps/v1/deployments', [
        deployment('default', ff('f-copied'), 3),
        deployment('ff-t-aaaaaaaaaaaa', { 'app.kubernetes.io/managed-by': 'ff-controller' }, 1),
        deployment('ff-t-aaaaaaaaaaaa', ff('f-real'), 1),
      ]);

      expect(Object.fromEntries(await orchestrator.readyInstancesByFunction())).toEqual({ 'f-real': 1 });
    });
  });

  describe("codeImagesByFunction: the image each function's pods mount, for the restore of lost images", () => {
    const IMAGE = 'registry.ff.internal/ff-code/123456789012@sha256:' + 'a'.repeat(64);
    const deployment = (namespace: string, functionId: string | undefined, volumes: unknown[]) => ({
      metadata: { name: 'fn-x', namespace, labels: { 'app.kubernetes.io/managed-by': 'ff-controller', ...(functionId ? { 'ff.dev/function-id': functionId } : {}) } },
      spec: { template: { spec: { volumes } } },
    });

    it("lists FF's Deployments in one call, and gives each function's code image; none for code mounted another way, or outside FF's namespaces", async () => {
      api.lists.set('/apis/apps/v1/deployments', [
        deployment('ff-t-aaaaaaaaaaaa', 'f-image', [{ name: 'tmp', emptyDir: {} }, { name: 'code', image: { reference: IMAGE, pullPolicy: 'IfNotPresent' } }]),
        // A function deployed before its code came as an image: its code ConfigMap until its next rollout.
        deployment('ff-t-aaaaaaaaaaaa', 'f-configmap', [{ name: 'code', configMap: { name: 'fn-f-configmap-code-1' } }]),
        deployment('default', 'f-copied', [{ name: 'code', image: { reference: IMAGE } }]),
        deployment('ff-t-aaaaaaaaaaaa', undefined, [{ name: 'code', image: { reference: IMAGE } }]),
      ]);

      const images = await orchestrator.codeImagesByFunction();

      expect(api.listed).toEqual([{ path: '/apis/apps/v1/deployments', selector: 'app.kubernetes.io/managed-by=ff-controller' }]);
      expect(Object.fromEntries(images)).toEqual({ 'f-image': IMAGE });
    });
  });

  describe('ping: whether the cluster answers, for the readiness probe', () => {
    it('asks the API server its version, within the time given', async () => {
      api.responses.push({ status: 200, headers: {}, body: '{"major":"1","minor":"31"}' });

      await orchestrator.ping(2000);

      expect(api.requests).toEqual([{ method: 'GET', path: '/version', options: { timeoutMs: 2000 } }]);
    });

    it('rejects with why when the API server refuses or does not answer', async () => {
      api.responses.push({ status: 401, headers: {}, body: 'Unauthorized' }, new Error('Kubernetes API request timed out after 2000 ms: GET /version'));

      await expect(orchestrator.ping(2000)).rejects.toThrow('the API server answered 401');
      await expect(orchestrator.ping(2000)).rejects.toThrow('timed out after 2000 ms');
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

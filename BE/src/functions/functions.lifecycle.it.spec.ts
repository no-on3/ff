/**
 * L3: the function lifecycle (client-readiness plan, P-03 and P-08) on the live dev
 * cluster: FunctionsService with the real Kubernetes driver and the
 * least-privilege ff-controller token. Records live in memory: what is under
 * test is how the service drives Kubernetes, and the database is not.
 *   npm run test:it      (or hack/k8s/test-it.sh)
 */
import { BadRequestException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import * as path from 'node:path';
import { KubeClient, paths } from '../orchestrator/kubernetes/kube-client';
import { KubernetesOrchestrator } from '../orchestrator/kubernetes/kubernetes.orchestrator';
import { LABELS, functionResourceName, accountNamespace } from '../orchestrator/kubernetes/naming';
import { settings } from '../orchestrator/kubernetes/test-fixtures';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { FunctionStatus, Function, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { FUNCTION_DEFAULTS, MemoryRepository, eventually } from './test-fixtures';

const run = process.env.K8S_IT === '1' ? describe : describe.skip;
const kubeDir = path.resolve(__dirname, '../../../hack/.kube');
const READY_TIMEOUT_SECONDS = 30;

const greeter = (version: string) => `
export async function handler(event: { body: { name?: string } }) {
  return { version: '${version}', message: 'Hello ' + (event.body.name ?? 'world') };
}`;
// Loads, then throws: the pod runs but never becomes ready.
const broken = 'throw new Error("boom at init");';

run('function lifecycle against the dev cluster (L3, P-03)', () => {
  jest.setTimeout(240_000);

  const s = settings({
    apiUrl: process.env.K8S_API_URL ?? 'https://127.0.0.1:6550',
    tokenFile: process.env.K8S_TOKEN_FILE ?? path.join(kubeDir, 'ff-controller.token'),
    caFile: process.env.K8S_CA_FILE ?? path.join(kubeDir, 'ca.crt'),
    invokeMode: 'proxy',
    readyTimeoutSeconds: 90,
    ingressAllowCidrs: (process.env.K8S_INGRESS_ALLOW_CIDRS ?? '').split(',').filter(Boolean),
  });
  const client = new KubeClient({ server: s.apiUrl, tokenFile: s.tokenFile, caFile: s.caFile });
  const orchestrator = new KubernetesOrchestrator(s, client);
  const account = String(randomInt(1e12)).padStart(12, '0');
  const ns = accountNamespace(s.namespacePrefix, account);
  const functions = new MemoryRepository<Function>(FUNCTION_DEFAULTS);
  const invocations = new MemoryRepository<FunctionInvocation>();
  const storage = { uploadCode: jest.fn(), deleteCode: jest.fn() };
  const config = {
    get: (key: string, fallback?: unknown) => (key === 'orchestrator.readyTimeoutSeconds' ? READY_TIMEOUT_SECONDS : fallback),
  };
  const service = new FunctionsService(
    functions as never,
    invocations as never,
    storage as never,
    orchestrator,
    config as never,
    { recordMetric: jest.fn(), invocationStarted: jest.fn(), invocationFinished: jest.fn() } as never,
  );
  const spec = (name: string, code: string) => ({ name, runtime: Runtime.NODEJS, code, memory: 128, timeout: 3 });

  const pods = (fn: Function) =>
    client.list<{ metadata: { name: string } }>(paths.core(ns, 'pods'), `${LABELS.functionId}=${fn.id}`);
  const desiredReplicas = async (fn: Function) =>
    (await client.get<{ spec?: { replicas?: number } }>(paths.apps(ns, 'deployments', functionResourceName(fn.id))))
      ?.spec?.replicas;
  const scaledToZero = async (fn: Function) => {
    await orchestrator.scale(fn, 0);
    await eventually(async () => (await pods(fn)).length === 0, 90_000);
  };

  afterAll(async () => {
    for (const fn of functions.rows.values()) await orchestrator.remove(fn).catch(() => undefined);
    await client.delete(paths.namespace(ns)).catch(() => undefined); // allowed: managed ff-t-* namespace
  });

  it('a broken create ends ERROR without a pod; an update with fixed code makes it ACTIVE and invocable', async () => {
    const failure = await service.create(account, spec('it-broken-create', broken)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    const fn = functions.byName('it-broken-create');
    // The function's own error, from its runtime's log, as its owner sees it (P-10).
    expect(fn).toMatchObject({ status: FunctionStatus.ERROR, error: 'The function failed to load: Runtime.ImportModuleError: Error: boom at init' });
    expect(await desiredReplicas(fn)).toBe(0);
    await eventually(async () => (await pods(fn)).length === 0, 90_000);

    const repaired = await service.update(account, fn.id, { code: greeter('repaired') });

    expect(repaired).toMatchObject({ status: FunctionStatus.ACTIVE, error: null });
    expect((await service.invoke(account, fn.id, { name: 'again' })).output).toEqual({ version: 'repaired', message: 'Hello again' });
  });

  it('rolls back a broken update of a working function: after a scale to zero, the cold start still runs the old code', async () => {
    const fn = await service.create(account, spec('it-rollback', greeter('v1')));

    const failure = await service.update(account, fn.id, { code: broken }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as Error).message).toMatch(/boom at init.*The update was rolled back/s);
    expect(functions.byName('it-rollback')).toMatchObject({ status: FunctionStatus.ACTIVE, code: greeter('v1') });

    await scaledToZero(fn);
    expect((await service.invoke(account, fn.id, {})).output).toEqual({ version: 'v1', message: 'Hello world' });
  });

  it('checks an update of a function scaled to zero on a real pod: broken code is refused, good code goes live', async () => {
    const fn = functions.byName('it-rollback');
    await scaledToZero(fn);

    const failure = await service.update(account, fn.id, { code: broken }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(functions.byName('it-rollback')).toMatchObject({ status: FunctionStatus.ACTIVE, code: greeter('v1') });

    await scaledToZero(fn);
    const updated = await service.update(account, fn.id, { code: greeter('v2') });

    expect(updated.status).toBe(FunctionStatus.ACTIVE);
    expect(await orchestrator.readyInstances(updated)).toBeGreaterThanOrEqual(1);
    expect((await service.invoke(account, fn.id, {})).output).toEqual({ version: 'v2', message: 'Hello world' });
  });

  it('records a call the runtime never answers as TIMEOUT through the API server proxy too, as in direct mode (P-08)', async () => {
    const fn = await service.create(account, spec('it-silent', greeter('v1')));
    // A hung runtime: it answers its probes, but never an invocation.
    const silent = "require('http').createServer((req, res) => { if (req.url !== '/invoke') res.end('ok'); }).listen(8080)";
    await client.request('PATCH', paths.apps(ns, 'deployments', functionResourceName(fn.id)), {
      body: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'function', command: ['node', '-e', silent] }] } } } }),
      contentType: 'application/strategic-merge-patch+json',
    });
    await orchestrator.waitUntilReady(fn, 90_000);

    const failure = await service.invoke(account, fn.id, {}).catch((error: unknown) => error);

    // The backend waits one timeout for a free instance, then the 3 s timeout, then 2 s more.
    expect(failure).toBeInstanceOf(BadRequestException);
    expect(await invocations.find({ where: { functionId: fn.id } })).toEqual([
      expect.objectContaining({ status: InvocationStatus.TIMEOUT, error: 'Sandbox.Timedout: No response within 8000 ms' }),
    ]);
  });
});

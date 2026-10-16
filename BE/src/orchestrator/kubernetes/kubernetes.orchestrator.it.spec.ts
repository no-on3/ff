/**
 * L3: the Kubernetes driver against the live dev cluster. Requires the cluster
 * (hack/k8s/cluster-up.sh) and the runtime images (hack/k8s/load-images.sh).
 * Uses the least-privilege ff-controller token, like the backend.
 *   npm run test:it
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Runtime } from '../../functions/entities/function.entity';
import { KubeClient, paths } from './kube-client';
import { KubernetesOrchestrator } from './kubernetes.orchestrator';
import { LABELS, functionResourceName, tenantNamespace } from './naming';
import { settings, workload } from './test-fixtures';

const run = process.env.K8S_IT === '1' ? describe : describe.skip;
const kubeDir = path.resolve(__dirname, '../../../../hack/.kube');

const greeter = (version: number) => `
export async function handler(event: { body: { name?: string } }) {
  return { version: ${version}, message: 'Hello ' + (event.body.name ?? 'world') };
}`;

const pythonGreeter = `
import os


def handler(event, context):
    if event["body"].get("fail"):
        raise ValueError("no thanks")
    return {
        "message": "Hello " + event["body"].get("name", "world"),
        "memoryLimitInMB": context.memory_limit_in_mb,
        "cwd": os.getcwd(),
    }
`;

// Checks from inside a function pod which destinations the tenant NetworkPolicy allows.
const networkProbe = `
import * as dns from 'node:dns/promises';
import * as net from 'node:net';

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function handler() {
  const resolved = await dns.lookup('kube-dns.kube-system.svc.cluster.local').catch(() => null);
  return {
    dnsLookup: resolved !== null,
    kubeDnsTcp53: resolved ? await reachable(resolved.address, 53) : false,
    apiServer: await reachable('10.43.0.1', 443),
  };
}`;

async function eventually(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

run('KubernetesOrchestrator against the dev cluster (L3)', () => {
  jest.setTimeout(180_000);

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
  const tenant = `it-${randomUUID()}`;
  const ns = tenantNamespace(s.namespacePrefix, tenant);
  const fn = workload({ id: randomUUID(), userId: tenant, name: 'it-greeter', code: greeter(1), memory: 128, timeout: 5 });
  const deploymentPath = paths.apps(ns, 'deployments', functionResourceName(fn.id));

  afterAll(async () => {
    await orchestrator.remove(fn).catch(() => undefined);
    await client.delete(paths.namespace(ns)).catch(() => undefined); // allowed: managed ff-t-* namespace
  });

  it('deploys a function and serves invocations through the API server proxy', async () => {
    await orchestrator.deploy(fn);
    await orchestrator.waitUntilReady(fn, 90_000);

    const result = await orchestrator.invoke(fn, { name: 'Kubernetes' });

    expect(result.output).toEqual({ version: 1, message: 'Hello Kubernetes' });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.memoryUsedMb).toBeGreaterThan(0);
  });

  it('rolls out new code with zero downtime semantics', async () => {
    fn.code = greeter(2);
    await orchestrator.update(fn);
    await orchestrator.waitUntilReady(fn, 90_000);

    expect((await orchestrator.invoke(fn, {})).output).toEqual({ version: 2, message: 'Hello world' });
  });

  it('scales to zero and cold-starts on the next invocation', async () => {
    await orchestrator.scale(fn, 0);
    await eventually(async () => (await orchestrator.readyInstances(fn)) === 0, 60_000);

    const result = await orchestrator.invoke(fn, {});

    expect(result.output).toMatchObject({ version: 2 });
    expect(await orchestrator.readyInstances(fn)).toBeGreaterThanOrEqual(1);
  });

  it('enforces the tenant NetworkPolicy: DNS allowed, cluster-internal addresses blocked', async () => {
    fn.code = networkProbe;
    await orchestrator.update(fn);
    await orchestrator.waitUntilReady(fn, 90_000);

    const { output } = await orchestrator.invoke(fn, {});

    expect(output).toEqual({ dnsLookup: true, kubeDnsTcp53: true, apiServer: false });
  });

  it('reports initialization failures with diagnostics instead of hanging', async () => {
    const broken = workload({ id: randomUUID(), userId: tenant, name: 'it-broken', code: 'throw new Error("boom at init");', timeout: 3 });
    try {
      await orchestrator.deploy(broken);
      await expect(orchestrator.waitUntilReady(broken, 25_000)).rejects.toThrow(/did not become ready.*boom at init/s);
    } finally {
      await orchestrator.remove(broken);
    }
  });

  it('runs a Python function with the Lambda handler signature and error names', async () => {
    const py = workload({ id: randomUUID(), userId: tenant, name: 'it-python', runtime: Runtime.PYTHON, code: pythonGreeter, memory: 128, timeout: 5 });
    try {
      await orchestrator.deploy(py);
      await orchestrator.waitUntilReady(py, 90_000);

      const result = await orchestrator.invoke(py, { name: 'Python' });
      const failure = await orchestrator.invoke(py, { fail: true }).catch((error: unknown) => error);

      expect(result.output).toEqual({ message: 'Hello Python', memoryLimitInMB: '128', cwd: '/var/task' });
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.memoryUsedMb).toBeGreaterThan(0);
      expect(failure).toMatchObject({ errorType: 'ValueError', message: 'no thanks' });
    } finally {
      await orchestrator.remove(py);
    }
  });

  it('removes every resource of the function', async () => {
    await orchestrator.remove(fn);

    expect(await client.get(deploymentPath)).toBeNull();
    expect(await client.get(paths.core(ns, 'services', functionResourceName(fn.id)))).toBeNull();
    expect(await client.list(paths.core(ns, 'configmaps'), `${LABELS.functionId}=${fn.id}`)).toHaveLength(0);
  });
});

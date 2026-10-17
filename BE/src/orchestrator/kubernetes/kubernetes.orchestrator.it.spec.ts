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
// Set by hack/k8s/test-it.sh when the gvisor RuntimeClass exists (hack/k8s/gvisor-up.sh).
const sandboxClass = process.env.K8S_IT_RUNTIME_CLASS;
const itSandboxed = sandboxClass ? it : it.skip;
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

// Hoards memory until the runtime stops it.
const pythonHog = `
def handler(event, context):
    hoard = []
    while event["body"].get("hog"):
        hoard.append(bytearray(4 * 1024 * 1024))
    return "ok"
`;

const nodeHog = `
const hoard: string[][] = [];
export async function handler(event: { body: { hog?: boolean } }) {
  while (event.body.hog) hoard.push(new Array(100_000).fill('x'.repeat(8)));
  return 'ok';
}`;

// Reads a file next to its code through a relative path: Lambda runs functions in their task root.
const readsItsOwnCode = `
import * as fs from 'node:fs';
export async function handler() {
  return { cwd: process.cwd(), readsItself: fs.readFileSync('function.ts', 'utf8').includes('readsItself') };
}`;

// gVisor reports its own kernel version ("4.19.0-gvisor"), not the node's.
const kernelProbe: Record<Runtime, string> = {
  [Runtime.NODEJS]: `import * as os from 'node:os';
export async function handler() { return { kernel: os.release() }; }`,
  [Runtime.PYTHON]: 'import platform\n\n\ndef handler(event, context):\n    return {"kernel": platform.release()}\n',
};

interface PodStatus {
  status?: { containerStatuses?: Array<{ restartCount: number }> };
}

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

  it('turns a Python memory hog into Runtime.OutOfMemory without restarting the container', async () => {
    // The container limit equals the function memory, as on Lambda. Reaching it would get
    // the whole container killed, so the runtime must stop the worker first.
    const hog = workload({ id: randomUUID(), userId: tenant, name: 'it-python-hog', runtime: Runtime.PYTHON, code: pythonHog, memory: 128, timeout: 10 });
    try {
      await orchestrator.deploy(hog);
      await orchestrator.waitUntilReady(hog, 90_000);

      const failure = await orchestrator.invoke(hog, { hog: true }).catch((error: unknown) => error);
      const after = await orchestrator.invoke(hog, {});
      const pods = await client.list<PodStatus>(paths.core(ns, 'pods'), `${LABELS.functionId}=${hog.id}`);

      expect(failure).toMatchObject({ errorType: 'Runtime.OutOfMemory', message: 'Runtime exceeded its memory limit' });
      expect(after.output).toBe('ok');
      expect(pods.map((pod) => pod.status?.containerStatuses?.[0]?.restartCount)).toEqual([0]);
    } finally {
      await orchestrator.remove(hog);
    }
  });

  it('runs a Node.js function in /var/task, where a relative path finds the files next to its code', async () => {
    const reader = workload({ id: randomUUID(), userId: tenant, name: 'it-cwd', code: readsItsOwnCode, memory: 128, timeout: 5 });
    try {
      await orchestrator.deploy(reader);
      await orchestrator.waitUntilReady(reader, 90_000);

      expect((await orchestrator.invoke(reader, {})).output).toEqual({ cwd: '/var/task', readsItself: true });
    } finally {
      await orchestrator.remove(reader);
    }
  });

  it('turns a Node.js heap hog into Runtime.OutOfMemory without restarting the container', async () => {
    // 30 s, not 10: at 0.1 CPU, V8's last collections near the heap limit once took
    // longer than 10 s, and the invocation timed out first (P-04).
    const hog = workload({ id: randomUUID(), userId: tenant, name: 'it-node-hog', code: nodeHog, memory: 128, timeout: 30 });
    try {
      await orchestrator.deploy(hog);
      await orchestrator.waitUntilReady(hog, 90_000);

      const failure = await orchestrator.invoke(hog, { hog: true }).catch((error: unknown) => error);
      const after = await orchestrator.invoke(hog, {});
      const pods = await client.list<PodStatus>(paths.core(ns, 'pods'), `${LABELS.functionId}=${hog.id}`);

      expect(failure).toMatchObject({ errorType: 'Runtime.OutOfMemory' });
      expect(after.output).toBe('ok');
      expect(pods.map((pod) => pod.status?.containerStatuses?.[0]?.restartCount)).toEqual([0]);
    } finally {
      await orchestrator.remove(hog);
    }
  });

  itSandboxed(`runs Node.js and Python functions inside the ${sandboxClass} sandbox, network policy intact`, async () => {
    const sandboxed = new KubernetesOrchestrator({ ...s, runtimeClass: sandboxClass! }, client);
    const fns = [
      ...[Runtime.NODEJS, Runtime.PYTHON].map((runtime) =>
        workload({ id: randomUUID(), userId: tenant, name: `it-sandbox-${runtime}`, runtime, code: kernelProbe[runtime], memory: 128, timeout: 5 }),
      ),
      workload({ id: randomUUID(), userId: tenant, name: 'it-sandbox-network', code: networkProbe, memory: 128, timeout: 10 }),
    ];
    try {
      for (const f of fns) await sandboxed.deploy(f);
      for (const f of fns) await sandboxed.waitUntilReady(f, 90_000);
      const outputs: unknown[] = [];
      for (const f of fns) outputs.push((await sandboxed.invoke(f, {})).output);

      expect(outputs).toEqual([
        { kernel: expect.stringContaining('gvisor') },
        { kernel: expect.stringContaining('gvisor') },
        { dnsLookup: true, kubeDnsTcp53: true, apiServer: false },
      ]);
    } finally {
      for (const f of fns) await sandboxed.remove(f);
    }
  });

  it('explains a missing RuntimeClass instead of waiting silently', async () => {
    const misconfigured = new KubernetesOrchestrator({ ...s, runtimeClass: 'ff-missing' }, client);
    const lost = workload({ id: randomUUID(), userId: tenant, name: 'it-no-runtimeclass', code: greeter(1), timeout: 3 });
    try {
      await misconfigured.deploy(lost);
      await expect(misconfigured.waitUntilReady(lost, 15_000)).rejects.toThrow(/no pods were created: .*RuntimeClass "ff-missing" not found/);
    } finally {
      await misconfigured.remove(lost);
    }
  });

  it('removes every resource of the function', async () => {
    await orchestrator.remove(fn);

    expect(await client.get(deploymentPath)).toBeNull();
    expect(await client.get(paths.core(ns, 'services', functionResourceName(fn.id)))).toBeNull();
    expect(await client.list(paths.core(ns, 'configmaps'), `${LABELS.functionId}=${fn.id}`)).toHaveLength(0);
  });
});

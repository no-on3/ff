/**
 * L3: the Kubernetes driver against the live dev cluster. Requires the cluster
 * (hack/k8s/cluster-up.sh) and the runtime images (hack/k8s/load-images.sh).
 * Uses the least-privilege ff-controller token, like the backend.
 *   npm run test:it
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Runtime } from '../../functions/entities/function.entity';
import { FunctionLoadError, OrchestratorError } from '../orchestrator.errors';
import { KubeClient, paths } from './kube-client';
import { KubernetesOrchestrator } from './kubernetes.orchestrator';
import { LABELS, functionResourceName, accountNamespace } from './naming';
import { TENANT_QUOTA_NAME } from './manifests';
import { FunctionWorkload } from '../orchestrator.types';
import { inlineCodeImage } from '../../functions/test-fixtures';
import { settings, tenant as limits, workload } from './test-fixtures';

const run = process.env.K8S_IT === '1' ? describe : describe.skip;
// Set by hack/k8s/test-it.sh when the gvisor RuntimeClass exists (hack/k8s/gvisor-up.sh).
const sandboxClass = process.env.K8S_IT_RUNTIME_CLASS;
const itSandboxed = sandboxClass ? it : it.skip;
// Set by hack/k8s/test-it.sh when the host reaches the internet, through which the cluster's pods do.
const itOnline = process.env.K8S_IT_INTERNET === '1' ? it : it.skip;
// Set by hack/k8s/test-it.sh when the development server of customers' databases runs (hack/k8s/data-db-up.sh): its
// address, and the CA of its certificate.
const dataDbAddress = process.env.K8S_IT_DATA_DB;
const dataDbRuns = process.env.K8S_IT === '1' && Boolean(dataDbAddress);
const runDataDb = dataDbRuns ? describe : describe.skip;
const kubeDir = path.resolve(__dirname, '../../../../hack/.kube');

const greeter = (version: number) => `
export async function handler(event: { name?: string }) {
  return { version: ${version}, message: 'Hello ' + (event.name ?? 'world') };
}`;

const pythonGreeter = `
import os


def handler(event, context):
    if event.get("fail"):
        raise ValueError("no thanks")
    return {
        "message": "Hello " + event.get("name", "world"),
        "memoryLimitInMB": context.memory_limit_in_mb,
        "cwd": os.getcwd(),
    }
`;

// Hoards memory until the runtime stops it.
const pythonHog = `
def handler(event, context):
    hoard = []
    while event.get("hog"):
        hoard.append(bytearray(4 * 1024 * 1024))
    return "ok"
`;

const nodeHog = `
const hoard: string[][] = [];
export async function handler(event: { hog?: boolean }) {
  while (event.hog) hoard.push(new Array(100_000).fill('x'.repeat(8)));
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

// Whether a TCP connection opens, from inside a function pod.
const reachable = `
import * as net from 'node:net';

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}`;

// Checks from inside a function pod which destinations the tenant NetworkPolicy allows.
const networkProbe = `
import * as dns from 'node:dns/promises';
${reachable}

export async function handler() {
  const resolved = await dns.lookup('kube-dns.kube-system.svc.cluster.local').catch(() => null);
  return {
    dnsLookup: resolved !== null,
    kubeDnsTcp53: resolved ? await reachable(resolved.address, 53) : false,
    apiServer: await reachable('10.43.0.1', 443),
  };
}`;

// The internet (Cloudflare's resolver, by address: no name to resolve), and FF's own network (the API server).
const egressProbe = `${reachable}

export async function handler() {
  return { internet: await reachable('1.1.1.1', 443), apiServer: await reachable('10.43.0.1', 443) };
}`;

// Customers' database server, from inside a function pod: its port, and its certificate as Node.js checks it once
// PostgreSQL's SSLRequest has opened TLS, against Node.js's CAs and those NODE_EXTRA_CA_CERTS names.
const dataDbProbe = (host: string) => `
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as tls from 'node:tls';
${reachable}

function certificate(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(3000, () => { socket.destroy(); resolve('timeout'); });
    socket.once('error', (error) => resolve(error.message));
    socket.once('connect', () => socket.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])));
    socket.once('data', (answer) => {
      if (answer.toString() !== 'S') return resolve('no TLS');
      const secure = tls.connect({ socket, host });
      secure.once('secureConnect', () => { resolve(secure.authorized ? 'trusted' : String(secure.authorizationError)); secure.destroy(); });
      secure.once('error', (error) => resolve(error.message));
    });
  });
}

export async function handler() {
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  return {
    server: await reachable('${host}', 5432),
    certificate: await certificate('${host}', 5432),
    caFile: ca !== undefined && fs.existsSync(ca) && fs.readFileSync(ca, 'utf8').includes('BEGIN CERTIFICATE'),
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
  const ns = accountNamespace(s.namespacePrefix, tenant);
  const fn = workload({ id: randomUUID(), accountId: tenant, name: 'it-greeter', code: greeter(1), memory: 128, timeout: 5 });
  const deploymentPath = paths.apps(ns, 'deployments', functionResourceName(fn.id));
  // A function's code reaches its pods as an image (ADR 0003): each version's, made and pushed to the development registry.
  const imaged = async (overrides: Partial<FunctionWorkload>): Promise<FunctionWorkload> => {
    const made = workload(overrides);
    return { ...made, codeImage: await inlineCodeImage(made.code, made.runtime, made.accountId) };
  };
  const withCode = async (target: FunctionWorkload, code: string): Promise<void> => {
    target.code = code;
    target.codeImage = await inlineCodeImage(code, target.runtime, target.accountId);
  };

  beforeAll(async () => {
    await withCode(fn, fn.code);
  });

  afterAll(async () => {
    await orchestrator.remove(fn).catch(() => undefined);
    await client.delete(paths.namespace(ns)).catch(() => undefined); // allowed: managed ff-t-* namespace
  });

  it('deploys a function and serves invocations through the API server proxy', async () => {
    await orchestrator.deploy(fn, limits());
    await orchestrator.waitUntilReady(fn, 90_000);

    const result = await orchestrator.invoke(fn, { name: 'Kubernetes' });

    expect(result.output).toEqual({ version: 1, message: 'Hello Kubernetes' });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.memoryUsedMb).toBeGreaterThan(0);
  });

  it("sizes the account namespace's quota from its plan, and a plan change rewrites it at once (P-15)", async () => {
    const hard = async () =>
      (await client.get<{ spec: { hard: Record<string, string> } }>(paths.core(ns, 'resourcequotas', TENANT_QUOTA_NAME)))?.spec.hard;
    expect(await hard()).toMatchObject({ pods: '20', 'requests.cpu': '8', 'limits.cpu': '8', 'limits.memory': '8Gi' });

    await orchestrator.applyTenantLimits(tenant, limits({ pods: 30, cpu: '12', memory: '12Gi' }));
    expect(await hard()).toMatchObject({ pods: '30', 'requests.cpu': '12', 'requests.memory': '12Gi', 'limits.memory': '12Gi' });

    await orchestrator.applyTenantLimits(tenant, limits()); // back to the beta plan's, for the next tests
    expect(await hard()).toMatchObject({ pods: '20' });
  });

  it('rolls out new code with zero downtime semantics', async () => {
    await withCode(fn, greeter(2));
    await orchestrator.update(fn, limits());
    await orchestrator.waitUntilReady(fn, 90_000);

    expect((await orchestrator.invoke(fn, {})).output).toEqual({ version: 2, message: 'Hello world' });
  });

  it("runs a version in pods of its own beside $LATEST, each call answered by the one it names; $LATEST's Service keeps its label through an update; both counted together", async () => {
    const tellsItsVersion = (code: string) => `
export async function handler(_event: unknown, context: { functionVersion: string }) {
  return { version: context.functionVersion, code: '${code}' };
}`;
    const latest = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-versions', code: tellsItsVersion('a'), memory: 128, timeout: 5 });
    const servicePath = paths.core(ns, 'services', functionResourceName(latest.id));
    const selector = async () => (await client.get<{ spec: { selector: Record<string, string> } }>(servicePath))?.spec.selector;
    try {
      await orchestrator.deploy(latest, limits());
      await orchestrator.waitUntilReady(latest, 90_000);
      // Published: version 1 is the function as it is, whose pods carry no version label yet.
      const version1 = { ...latest, version: 1, lastVersion: 1 };

      const first = await orchestrator.invoke({ ...version1, codeImage: undefined }, {}, undefined, async () => version1);

      expect(first.output).toEqual({ version: '1', code: 'a' });
      expect(first.initMs).toBeGreaterThan(0);
      expect(await selector()).toEqual({ [LABELS.functionId]: latest.id, [LABELS.version]: 'latest' });
      // $LATEST's code moves on, its pods keeping their label, which its apply now names too.
      latest.lastVersion = 1;
      await withCode(latest, tellsItsVersion('b'));
      await orchestrator.update(latest, limits());
      await orchestrator.waitUntilReady(latest, 90_000);
      // The apply left the label in its Service's selector, which another field manager set.
      expect(await selector()).toEqual({ [LABELS.functionId]: latest.id, [LABELS.version]: 'latest' });
      // A hundred calls each, each answered by the version it names: $LATEST's Service never takes version 1's pod.
      for (let i = 0; i < 100; i++) {
        expect((await orchestrator.invoke(latest, {})).output).toEqual({ version: '$LATEST', code: 'b' });
        expect((await orchestrator.invoke(version1, {})).output).toEqual({ version: '1', code: 'a' });
      }
      await eventually(async () => (await orchestrator.readyInstancesByFunction()).get(latest.id) === 2, 90_000);

      await orchestrator.removeVersion(version1);
      expect(await client.get(paths.apps(ns, 'deployments', `${functionResourceName(latest.id)}-v1`))).toBeNull();
      await eventually(async () => (await orchestrator.readyInstancesByFunction()).get(latest.id) === 1, 90_000);
      expect((await orchestrator.invoke(latest, {})).output).toEqual({ version: '$LATEST', code: 'b' });
    } finally {
      await orchestrator.remove(latest, [1]);
    }
    expect(await client.get(servicePath)).toBeNull();
  });

  it("counts the function's ready instances in one cluster-wide list, at 1, 2 and 0 replicas (P-21)", async () => {
    const counted = async () => (await orchestrator.readyInstancesByFunction()).get(fn.id);
    expect(await counted()).toBe(1);

    await orchestrator.scale(fn, 2);
    await eventually(async () => (await counted()) === 2, 90_000);

    await orchestrator.scale(fn, 0);
    await eventually(async () => (await counted()) === undefined, 90_000); // no ready instance: left out

    await orchestrator.scale(fn, 1); // as the next test expects
    await eventually(async () => (await counted()) === 1, 90_000);
  });

  it('scales to zero and cold-starts on the next invocation', async () => {
    await orchestrator.scale(fn, 0);
    await eventually(async () => (await orchestrator.readyInstances(fn)) === 0, 60_000);

    const result = await orchestrator.invoke(fn, {});

    expect(result.output).toMatchObject({ version: 2 });
    expect(await orchestrator.readyInstances(fn)).toBeGreaterThanOrEqual(1);
  });

  it('enforces the tenant NetworkPolicy: DNS allowed, cluster-internal addresses blocked', async () => {
    await withCode(fn, networkProbe);
    await orchestrator.update(fn, limits());
    await orchestrator.waitUntilReady(fn, 90_000);

    const { output } = await orchestrator.invoke(fn, {});

    expect(output).toEqual({ dnsLookup: true, kubeDnsTcp53: true, apiServer: false });
  });

  // Off for every account until the operator turns it on in the admin dashboard.
  itOnline("keeps an account's functions off the internet until its egress is on, and off FF's own network either way", async () => {
    const probe = async () => (await orchestrator.invoke(fn, {})).output as { internet: boolean; apiServer: boolean };
    await withCode(fn, egressProbe);
    await orchestrator.update(fn, limits());
    await orchestrator.waitUntilReady(fn, 90_000);
    const off = await probe();

    let on = off;
    await orchestrator.applyTenantLimits(tenant, limits({}, true));
    await eventually(async () => (on = await probe()).internet, 30_000);
    let offAgain = on;
    await orchestrator.applyTenantLimits(tenant, limits());
    await eventually(async () => !(offAgain = await probe()).internet, 30_000);

    expect([off, on, offAgain]).toEqual([
      { internet: false, apiServer: false },
      { internet: true, apiServer: false },
      { internet: false, apiServer: false },
    ]);
  });

  it("reports the function's own load error, from its runtime's log, as soon as it's there rather than at the timeout", async () => {
    const broken = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-broken', code: 'throw new Error("boom at init");', timeout: 3 });
    try {
      await orchestrator.deploy(broken, limits());
      const started = Date.now();
      const failure = await orchestrator.waitUntilReady(broken, 90_000).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FunctionLoadError);
      expect(failure).toMatchObject({ errorType: 'Runtime.ImportModuleError', message: 'Error: boom at init' });
      // The pod starts in seconds and the log store has its lines about 5 s later; the timeout is 90 s.
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally {
      await orchestrator.remove(broken);
    }
  });

  it('runs a Python function with the Lambda handler signature and error names', async () => {
    const py = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-python', runtime: Runtime.PYTHON, code: pythonGreeter, memory: 128, timeout: 5 });
    try {
      await orchestrator.deploy(py, limits());
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
    const hog = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-python-hog', runtime: Runtime.PYTHON, code: pythonHog, memory: 128, timeout: 10 });
    try {
      await orchestrator.deploy(hog, limits());
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
    const reader = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-cwd', code: readsItsOwnCode, memory: 128, timeout: 5 });
    try {
      await orchestrator.deploy(reader, limits());
      await orchestrator.waitUntilReady(reader, 90_000);

      expect((await orchestrator.invoke(reader, {})).output).toEqual({ cwd: '/var/task', readsItself: true });
    } finally {
      await orchestrator.remove(reader);
    }
  });

  it('turns a Node.js heap hog into Runtime.OutOfMemory without restarting the container', async () => {
    // 30 s, not 10: at 0.1 CPU, V8's last collections near the heap limit once took
    // longer than 10 s, and the invocation timed out first (P-04).
    const hog = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-node-hog', code: nodeHog, memory: 128, timeout: 30 });
    try {
      await orchestrator.deploy(hog, limits());
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
    const fns = await Promise.all([
      ...[Runtime.NODEJS, Runtime.PYTHON].map((runtime) =>
        imaged({ id: randomUUID(), accountId: tenant, name: `it-sandbox-${runtime}`, runtime, code: kernelProbe[runtime], memory: 128, timeout: 5 }),
      ),
      imaged({ id: randomUUID(), accountId: tenant, name: 'it-sandbox-network', code: networkProbe, memory: 128, timeout: 10 }),
    ]);
    try {
      for (const f of fns) await sandboxed.deploy(f, limits());
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
    const lost = await imaged({ id: randomUUID(), accountId: tenant, name: 'it-no-runtimeclass', code: greeter(1), timeout: 3 });
    try {
      await misconfigured.deploy(lost, limits());
      const failure = misconfigured.waitUntilReady(lost, 15_000);
      // A platform failure: the details are for the server log (D4).
      await expect(failure).rejects.toBeInstanceOf(OrchestratorError);
      await expect(failure).rejects.toThrow(/no pods were created: .*RuntimeClass "ff-missing" not found/);
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

runDataDb("functions and customers' database server (ADR 0008, L3)", () => {
  jest.setTimeout(180_000);

  const address = dataDbAddress as string;
  const s = settings({
    apiUrl: process.env.K8S_API_URL ?? 'https://127.0.0.1:6550',
    tokenFile: process.env.K8S_TOKEN_FILE ?? path.join(kubeDir, 'ff-controller.token'),
    caFile: process.env.K8S_CA_FILE ?? path.join(kubeDir, 'ca.crt'),
    invokeMode: 'proxy',
    readyTimeoutSeconds: 90,
    ingressAllowCidrs: (process.env.K8S_INGRESS_ALLOW_CIDRS ?? '').split(',').filter(Boolean),
    platformEgress: [{ cidrs: [`${address}/32`], port: 5432 }],
    // Read only when the case runs: Jest builds a skipped describe's body too, and without the server there is no CA.
    dataDbCa: dataDbRuns ? fs.readFileSync(process.env.K8S_IT_DATA_DB_CA ?? path.resolve(kubeDir, '../.data-db/ca.crt'), 'utf8') : '',
  });
  const client = new KubeClient({ server: s.apiUrl, tokenFile: s.tokenFile, caFile: s.caFile });
  const orchestrator = new KubernetesOrchestrator(s, client);
  const tenant = `it-${randomUUID()}`;
  const fn = workload({ id: randomUUID(), accountId: tenant, name: 'it-data-db', code: dataDbProbe(address), memory: 128, timeout: 10 });
  const probe = async () => (await orchestrator.invoke(fn, {})).output as { server: boolean; certificate: string; caFile: boolean };

  beforeAll(async () => {
    fn.codeImage = await inlineCodeImage(fn.code, fn.runtime, fn.accountId);
  });

  afterAll(async () => {
    await orchestrator.remove(fn).catch(() => undefined);
    await client.delete(paths.namespace(accountNamespace(s.namespacePrefix, tenant))).catch(() => undefined);
  });

  it("reaches the server on its port, the account's internet access off, and trusts its certificate through NODE_EXTRA_CA_CERTS", async () => {
    await orchestrator.deploy(fn, limits());
    await orchestrator.waitUntilReady(fn, 90_000);

    expect(await probe()).toEqual({ server: true, certificate: 'trusted', caFile: true });
  });

  it("reaches it no more once the platform's rule is gone from the account's policy, the rest unchanged", async () => {
    await new KubernetesOrchestrator({ ...s, platformEgress: [] }, client).applyTenantLimits(tenant, limits());
    let found = await probe();
    await eventually(async () => !(found = await probe()).server, 30_000);

    expect(found).toMatchObject({ server: false, caFile: true });
  });
});

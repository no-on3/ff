/**
 * L3: the log pipeline (client-readiness plan P-42, ADR 0005) on the dev cluster. Functions deployed by the
 * Kubernetes driver print; Fluent Bit collects; VictoriaLogs answers. Runs where the pipeline is installed:
 * hack/k8s/test-it.sh sets K8S_IT_LOGGING when it finds it (hack/k8s/logging-up.sh installs it). Queries go
 * through the API server's Service proxy with the admin kubeconfig, as only the platform may query the store.
 * The last cases delete an account's lines (P-45) with the store's key, which test-it.sh copies from its Secret.
 *   hack/k8s/test-it.sh log-pipeline
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Runtime } from '../../functions/entities/function.entity';
import { LogStoreUnavailableError } from '../orchestrator.errors';
import type { FunctionLogLine } from '../orchestrator.types';
import { KubeClient, paths } from './kube-client';
import { KubernetesOrchestrator } from './kubernetes.orchestrator';
import { accountNamespace } from './naming';
import { inlineCodeImage } from '../../functions/test-fixtures';
import { settings, tenant as limits, workload } from './test-fixtures';

const run = process.env.K8S_IT === '1' && process.env.K8S_IT_LOGGING === '1' ? describe : describe.skip;
const repo = path.resolve(__dirname, '../../../..');
const kubeDir = path.join(repo, 'hack/.kube');
const kubectlBin = path.join(repo, 'hack/bin/kubectl');
const kubeconfig = process.env.KUBECONFIG ?? path.join(kubeDir, 'ff-dev.kubeconfig');
const execFileAsync = promisify(execFile);

/** The collector's budget per namespace and second (deploy/k8s/logging/30-fluent-bit.yaml). */
const LINES_PER_SECOND = 2000;

// Prints what it is asked to; or says whether it can reach the log store.
const printer = `
import * as net from 'node:net';

interface Event { body: { nonce?: string; lines?: number; stderr?: boolean; text?: string; probe?: boolean } }

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function handler(event: Event) {
  const { nonce = '', lines = 0, stderr = false, text, probe = false } = event;
  if (probe) return { victoriaLogs: await reachable('victoria-logs.ff-system.svc.cluster.local', 9428) };
  for (let i = 1; i <= lines; i++) console.log(nonce + ' ' + i);
  if (stderr) console.error(nonce + ' on stderr');
  if (text !== undefined) console.log(text);
  return 'ok';
}`;

const pythonPrinter = `
def handler(event, context):
    print("hello from python " + event["nonce"])
    return "ok"
`;

// Run in ff-system by reachesTheStoreFrom(): prints whether it could open a connection to the store within 15 s.
// It tries again until then: the network policy admits a new pod's address a moment after the pod starts, later
// while the cluster is busy, and a single try once found the backend's way closed.
const storeProbe = `
const deadline = Date.now() + 15000;
const done = (result) => { console.log(result); process.exit(0); };
const attempt = () => {
  let over = false;
  const socket = require('node:net').connect({ host: 'victoria-logs.ff-system.svc.cluster.local', port: 9428 });
  const next = () => {
    if (over) return;
    over = true;
    socket.destroy();
    if (Date.now() < deadline) setTimeout(attempt, 500);
    else done('refused');
  };
  socket.setTimeout(2000, next);
  socket.once('connect', () => done('reachable'));
  socket.once('error', next);
};
attempt();
`;

interface StoredLine {
  _msg: string;
  _time: string;
  namespace: string;
  function_id?: string;
  pod?: string;
  stream?: string;
  request_id?: string;
}

function kubectl(args: string[], input?: string): Promise<string> {
  if (input !== undefined) {
    return Promise.resolve(execFileSync(kubectlBin, ['--kubeconfig', kubeconfig, ...args], { input, encoding: 'utf8' }));
  }
  return execFileAsync(kubectlBin, ['--kubeconfig', kubeconfig, ...args], { maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);
}

/** A LogsQL query's lines, through the API server's proxy to the store. */
async function query(logsql: string): Promise<StoredLine[]> {
  const params = new URLSearchParams({ query: logsql });
  const out = await kubectl(['get', '--raw', `/api/v1/namespaces/ff-system/services/victoria-logs:http/proxy/select/logsql/query?${params}`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredLine);
}

async function count(logsql: string): Promise<number> {
  const [row] = (await query(`${logsql} | stats count() as n`)) as unknown as Array<{ n: string }>;
  return Number(row?.n ?? 0);
}

/** What a poll found: the value awaited, or what it saw instead. */
type Poll<T> = { done: T; last?: never } | { done?: never; last: unknown };

/** The value `probe` gives once it gives one, or a failure naming what it last saw. */
async function until<T>(what: string, timeoutMs: number, probe: () => Promise<Poll<T>>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result.done !== undefined) return result.done;
    if (Date.now() > deadline) throw new Error(`${what}, not within ${timeoutMs} ms; last seen: ${JSON.stringify(result.last)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Whether a pod in ff-system with these labels can open a connection to the store. */
async function reachesTheStoreFrom(labels: Record<string, string>): Promise<boolean> {
  const name = `it-log-probe-${randomUUID().slice(0, 8)}`;
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'ff-system', labels },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'probe',
          image: 'ff-runtime-nodejs:24-v3',
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', storeProbe],
          resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { memory: '64Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        },
      ],
    },
  };
  await kubectl(['apply', '-f', '-'], JSON.stringify(pod));
  try {
    await kubectl(['-n', 'ff-system', 'wait', '--for=jsonpath={.status.phase}=Succeeded', `pod/${name}`, '--timeout=90s']);
    return (await kubectl(['-n', 'ff-system', 'logs', name])).trim() === 'reachable';
  } finally {
    await kubectl(['-n', 'ff-system', 'delete', 'pod', name, '--wait=false']).catch(() => undefined);
  }
}

/** An alphanumeric word, so that LogsQL finds it as one. */
const word = (prefix: string) => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

run('the log pipeline on the dev cluster (L3)', () => {
  jest.setTimeout(240_000);

  const s = settings({
    apiUrl: process.env.K8S_API_URL ?? 'https://127.0.0.1:6550',
    tokenFile: process.env.K8S_TOKEN_FILE ?? path.join(kubeDir, 'ff-controller.token'),
    caFile: process.env.K8S_CA_FILE ?? path.join(kubeDir, 'ca.crt'),
    invokeMode: 'proxy',
    readyTimeoutSeconds: 90,
    logStoreDeleteKeyFile: process.env.K8S_LOG_STORE_DELETE_KEY_FILE ?? path.join(kubeDir, 'victoria-logs-delete-key'),
  });
  const client = new KubeClient({ server: s.apiUrl, tokenFile: s.tokenFile, caFile: s.caFile });
  const orchestrator = new KubernetesOrchestrator(s, client);
  const tenantA = `it-logs-a-${randomUUID()}`;
  const tenantB = `it-logs-b-${randomUUID()}`;
  const nsA = accountNamespace(s.namespacePrefix, tenantA);
  const nsB = accountNamespace(s.namespacePrefix, tenantB);
  const printerA = workload({ id: randomUUID(), accountId: tenantA, name: 'it-printer', code: printer, memory: 512, timeout: 60 });
  const python = workload({ id: randomUUID(), accountId: tenantA, name: 'it-python', runtime: Runtime.PYTHON, code: pythonPrinter, memory: 128, timeout: 10 });
  const printerB = workload({ id: randomUUID(), accountId: tenantB, name: 'it-printer', code: printer, memory: 128, timeout: 10 });
  const functions = [printerA, python, printerB];

  beforeAll(async () => {
    // Each function's code as an image, as the backend gives it (ADR 0003).
    for (const fn of functions) fn.codeImage = await inlineCodeImage(fn.code, fn.runtime, fn.accountId);
    for (const fn of functions) await orchestrator.deploy(fn, limits());
    await Promise.all(functions.map((fn) => orchestrator.waitUntilReady(fn, 120_000)));
  });

  afterAll(async () => {
    for (const fn of functions) await orchestrator.remove(fn).catch(() => undefined);
    for (const ns of [nsA, nsB]) await client.delete(paths.namespace(ns)).catch(() => undefined);
  });

  it("stores a call's lines, Node.js and Python, with the function, pod, stream and request ID, within 15 s", async () => {
    const nonce = word('n');
    const nodeCall = `it-log-node-${randomUUID()}`;
    const pythonCall = `it-log-python-${randomUUID()}`;
    await orchestrator.invoke(printerA, { nonce, lines: 2, stderr: true }, nodeCall);
    await orchestrator.invoke(python, { nonce }, pythonCall);
    const called = Date.now();

    // Node.js: START, two lines, one on stderr, END, REPORT. Python: START, its print, END, REPORT.
    const lines = await until<StoredLine[]>("the two calls' 10 lines", 30_000, async () => {
      const got = await query(`{namespace="${nsA}"} request_id:in("${nodeCall}", "${pythonCall}") _time:10m`);
      return got.length === 10 ? { done: got } : { last: got.map((l) => l._msg) };
    });
    const delayMs = Date.now() - called;

    const of = (call: string) =>
      lines.filter((l) => l.request_id === call).sort((a, b) => a._time.localeCompare(b._time) || a._msg.localeCompare(b._msg));
    const node = of(nodeCall);
    expect(node[0]._msg).toBe(`START RequestId: ${nodeCall} Version: $LATEST`);
    expect(node.at(-1)?._msg).toMatch(new RegExp(`^REPORT RequestId: ${nodeCall}\\tDuration: `));
    expect(node.map((l) => l._msg).sort()).toEqual(
      [`${nonce} 1`, `${nonce} 2`, `${nonce} on stderr`, `END RequestId: ${nodeCall}`, node[0]._msg, node.at(-1)?._msg].sort(),
    );
    for (const l of node) {
      expect({ namespace: l.namespace, function_id: l.function_id }).toEqual({ namespace: nsA, function_id: printerA.id });
      expect(l.pod).toMatch(new RegExp(`^fn-${printerA.id}-`));
      expect(l.stream).toBe(l._msg.endsWith('on stderr') ? 'stderr' : 'stdout');
    }
    const py = of(pythonCall);
    expect(py.map((l) => l._msg)).toEqual(expect.arrayContaining([`hello from python ${nonce}`, `END RequestId: ${pythonCall}`]));
    expect(py.every((l) => l.function_id === python.id && l.namespace === nsA && l.pod?.startsWith(`fn-${python.id}-`))).toBe(true);
    // The live tail's bound below, which reads the same store: a laptop stays under 5 s, the collector flushing each
    // second; GitHub's shared runners took 7.9 and 9.5 s for this first call through a pipeline just started.
    expect(delayMs).toBeLessThan(15_000);
  });

  it("reads pages of a function's lines as the logs API does (P-43): a call's, a phrase's, and back with the cursor", async () => {
    const nonce = word('page');
    const first = `it-log-page-1-${randomUUID()}`;
    await orchestrator.invoke(printerA, { nonce, lines: 5 }, first);
    await orchestrator.invoke(printerA, { nonce: word('other'), lines: 1 }, `it-log-page-2-${randomUUID()}`);
    const window = () => ({ start: new Date(Date.now() - 600_000), end: new Date(Date.now() + 1000), limit: 1000 });

    // The first call: START, its 5 lines, END and REPORT, oldest first.
    const call = await until<FunctionLogLine[]>("the first call's 8 lines", 30_000, async () => {
      const { lines } = await orchestrator.logs(printerA, { ...window(), requestId: first });
      return lines.length === 8 ? { done: lines } : { last: lines.map((l) => l.message) };
    });
    expect(call[0].message).toBe(`START RequestId: ${first} Version: $LATEST`);
    expect(call.slice(1, 6).map((l) => l.message)).toEqual([1, 2, 3, 4, 5].map((i) => `${nonce} ${i}`));
    expect(call.at(-1)?.message).toMatch(new RegExp(`^REPORT RequestId: ${first}\t`));
    expect(call.every((l) => l.requestId === first && l.stream === 'stdout' && l.instance?.startsWith(`fn-${printerA.id}-`))).toBe(true);

    // A phrase, as whole words.
    expect((await orchestrator.logs(printerA, { ...window(), q: `${nonce} 3` })).lines.map((l) => l.message)).toEqual([`${nonce} 3`]);

    // Pages of 3, back from the newest: the same 8 lines, none twice.
    const fixed = window();
    const pages: FunctionLogLine[][] = [];
    let cursor: string | undefined;
    do {
      const page = await orchestrator.logs(printerA, { ...fixed, limit: 3, requestId: first, cursor });
      pages.push(page.lines);
      cursor = page.next ?? undefined;
    } while (cursor !== undefined);
    expect(pages.map((page) => page.length)).toEqual([3, 3, 2]);
    expect(pages.reverse().flat()).toEqual(call);

    // A phrase written as LogsQL stays a phrase: nothing of other functions or accounts.
    expect((await orchestrator.logs(printerA, { ...window(), q: '"} OR {namespace=~".*"} OR "' })).lines).toEqual([]);
  });

  it("tails a function's lines as they come, narrowed to a call, about 5 s late (P-43)", async () => {
    const abort = new AbortController();
    const call = `it-log-tail-${randomUUID()}`;
    const nonce = word('tail');
    const lines = orchestrator.tailLogs(printerA, { requestId: call }, abort.signal);
    const seen: FunctionLogLine[] = [];
    const reading = (async () => {
      try {
        for await (const line of lines) {
          seen.push(line);
          if (line.message.startsWith(`REPORT RequestId: ${call}`)) return;
        }
      } catch {
        // the abort below, if the REPORT never came
      }
    })();

    await orchestrator.invoke(printerA, { nonce: word('other'), lines: 1 }, `it-log-tail-other-${randomUUID()}`);
    await orchestrator.invoke(printerA, { nonce, lines: 2 }, call);
    const called = Date.now();
    await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, 30_000))]);
    const delayMs = Date.now() - called;
    abort.abort();

    expect(seen.map((l) => l.message)).toEqual([
      `START RequestId: ${call} Version: $LATEST`,
      `${nonce} 1`,
      `${nonce} 2`,
      `END RequestId: ${call}`,
      expect.stringMatching(new RegExp(`^REPORT RequestId: ${call}\t`)),
    ]);
    expect(seen.every((l) => l.requestId === call && l.instance?.startsWith(`fn-${printerA.id}-`))).toBe(true);
    expect(delayMs).toBeLessThan(15_000);
  });

  it("limits a namespace printing in a loop to its budget a second, counts every line it drops, and keeps another namespace's", async () => {
    const nonce = word('flood');
    const floodCall = `it-log-flood-${randomUUID()}`;
    const quietCalls = Array.from({ length: 5 }, () => `it-log-quiet-${randomUUID()}`);
    const flood = orchestrator.invoke(printerA, { nonce, lines: 30_000 }, floodCall);
    for (const call of quietCalls) await orchestrator.invoke(printerB, { nonce: word('quiet'), lines: 5 }, call);
    await flood;

    // Each of the call's 30,003 lines (with START, END and REPORT) is either stored or counted in a notice.
    const { stored, dropped, notices } = await until<{ stored: number; dropped: number; notices: StoredLine[] }>('every flood line stored or counted', 60_000, async () => {
      const kept = await count(`{namespace="${nsA}", function_id="${printerA.id}"} request_id:="${floodCall}" _time:10m`);
      const said = await query(`{namespace="${nsA}", function_id="${printerA.id}"} stream:="ff" _time:10m`);
      const counted = said.reduce((sum, n) => sum + Number(/^FF dropped (\d+) /.exec(n._msg)?.[1] ?? NaN), 0);
      return kept + counted === 30_003 ? { done: { stored: kept, dropped: counted, notices: said } } : { last: { kept, counted } };
    });
    expect(dropped).toBeGreaterThan(0);
    expect(stored).toBeGreaterThan(0);
    expect(notices[0]._msg).toMatch(
      /^FF dropped \d+ of this function's log lines written at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC: its account wrote more than 2000 lines, or 1048576 bytes, in that second\.$/,
    );
    expect(notices.every((n) => n.namespace === nsA && n.request_id === undefined)).toBe(true);

    const perSecond = (await query(`{namespace="${nsA}"} request_id:="${floodCall}" _time:10m | stats by (_time:1s) count() as n`)) as unknown as Array<{ n: string }>;
    expect(Math.max(...perSecond.map((row) => Number(row.n)))).toBeLessThanOrEqual(LINES_PER_SECOND);

    // B's 5 calls, during the flood: each one's 5 lines, START, END and REPORT.
    const quiet = await until<number>("B's 40 lines", 30_000, async () => {
      const got = await count(`{namespace="${nsB}"} request_id:in(${quietCalls.map((c) => `"${c}"`).join(', ')}) _time:10m`);
      return got === 40 ? { done: got } : { last: got };
    });
    expect(quiet).toBe(40);
  });

  it('cuts a line past 16,384 bytes at the start of a character', async () => {
    const call = `it-log-long-${randomUUID()}`;
    await orchestrator.invoke(printerA, { text: '€'.repeat(40_000) }, call); // 120,000 bytes, written in parts

    const [line] = await until<StoredLine[]>('the long line', 30_000, async () => {
      const got = await query(`{namespace="${nsA}"} request_id:="${call}" "truncated" _time:10m`);
      return got.length === 1 ? { done: got } : { last: got.length };
    });
    // 16,384 bytes would end inside the 5,462nd euro sign, so the cut keeps 5,461 of them.
    expect(line._msg).toBe(`${'€'.repeat(5461)} …[truncated]`);
  });

  it('lets only the collector and the backend reach the store', async () => {
    expect((await orchestrator.invoke(printerB, { probe: true })).output).toEqual({ victoriaLogs: false });
    expect(await reachesTheStoreFrom({ 'app.kubernetes.io/name': 'it-anything' })).toBe(false);
    expect(await reachesTheStoreFrom({ 'app.kubernetes.io/name': 'ff-backend' })).toBe(true);
  });

  it("gives the collector read access to pods' and namespaces' metadata, and nothing more", async () => {
    const can = async (...args: string[]) =>
      (await kubectl(['auth', 'can-i', '--as=system:serviceaccount:ff-logging:fluent-bit', ...args]).catch(() => 'no')).trim();
    const allowed = [['list', 'pods', '-A'], ['watch', 'pods', '-A'], ['get', 'namespaces']];
    const denied = [
      ['get', 'secrets', '-A'],
      ['get', 'configmaps', '-A'],
      ['get', 'pods', '--subresource=log', '-A'],
      ['create', 'pods', '-n', nsA],
      ['delete', 'pods', '-n', nsA],
      ['patch', 'namespaces'],
      ['list', 'nodes'],
    ];
    expect(await Promise.all(allowed.map((a) => can(...a)))).toEqual(allowed.map(() => 'yes'));
    expect(await Promise.all(denied.map((a) => can(...a)))).toEqual(denied.map(() => 'no'));
  });

  // The last cases, P-45's: closing an account deletes its lines, and the first of them its namespace.
  it("deletes no line with a key the store doesn't take", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-it-'));
    writeFileSync(path.join(dir, 'key'), 'not-the-key');
    const wrongKey = new KubernetesOrchestrator({ ...s, logStoreDeleteKeyFile: path.join(dir, 'key') }, client);
    const before = await count(`{namespace="${nsB}"}`);

    const refusal = await wrongKey.deleteLogs(tenantB).then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(LogStoreUnavailableError);
    expect((refusal as Error).message).toMatch(/^The log store answered 401: /);
    expect((refusal as Error).message).not.toContain('not-the-key');
    expect(before).toBeGreaterThan(0);
    expect(await count(`{namespace="${nsB}"}`)).toBe(before);
  });

  it("deletes an account's namespace and every line of it, as closing the account does, and leaves another account's (P-45)", async () => {
    const nonce = word('closing');
    await orchestrator.invoke(printerA, { nonce, lines: 3 }, `it-log-close-a-${randomUUID()}`);
    await orchestrator.invoke(printerB, { nonce, lines: 3 }, `it-log-close-b-${randomUUID()}`);
    await until<boolean>("both accounts' new lines stored", 30_000, async () => {
      const [a, b] = await Promise.all([count(`{namespace="${nsA}"} "${nonce}"`), count(`{namespace="${nsB}"} "${nonce}"`)]);
      return a === 3 && b === 3 ? { done: true } : { last: { a, b } };
    });
    const [linesOfA, linesOfB] = await Promise.all([count(`{namespace="${nsA}"}`), count(`{namespace="${nsB}"}`)]);

    // Its functions first, then its namespace, so that nothing writes more of its lines; then the lines.
    for (const fn of [printerA, python]) await orchestrator.remove(fn);
    const removing = Date.now();
    await orchestrator.removeTenant(tenantA);
    const removedMs = Date.now() - removing;
    const deleting = Date.now();
    await orchestrator.deleteLogs(tenantA);
    const deletedMs = Date.now() - deleting;

    expect(await client.get(paths.namespace(nsA))).toBeNull();
    expect(linesOfA).toBeGreaterThan(30);
    expect(await count(`{namespace="${nsA}"}`)).toBe(0);
    expect(await count(`{namespace="${nsB}"}`)).toBe(linesOfB);
    // Again, as the next attempt after a failure would: nothing left to do, and nothing fails.
    await orchestrator.removeTenant(tenantA);
    await orchestrator.deleteLogs(tenantA);
    console.log(`P-45: the namespace went in ${removedMs} ms; ${linesOfA} lines deleted in ${deletedMs} ms; ${linesOfB} of the other account's kept`);
  });
});

/**
 * The cold-start benchmark: how long a function takes from its deploy to its
 * first answer, at a given size, with several deployed at once, as the backend
 * deploys them (its own Kubernetes driver, with the ff-controller token). For
 * each function it prints the deploy call to Ready, and from the pod: its
 * creation to its container's start, the start to the runtime listening, and
 * the runtime listening to the function's code loaded, which must fit in the
 * runtime's start-up limit (10 s at the smallest sizes). It deletes what it made.
 * Run it through hack/k8s/cold-start-benchmark.sh, which sets the cluster up;
 * K8S_RUNTIME_IMAGE_NODEJS and K8S_RUNTIME_IMAGE_PYTHON measure other images.
 *   hack/k8s/cold-start-benchmark.sh [--runtime-class gvisor] [--runtime nodejs|python] [--memory 128] [--at-once 3] [--rounds 2]
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { describeError } from '../src/common/describe-error';
import { EventFormat, Runtime } from '../src/functions/entities/function.entity';
import { FunctionWorkload } from '../src/orchestrator/orchestrator.types';
import { KubeClient, paths } from '../src/orchestrator/kubernetes/kube-client';
import { KubernetesOrchestrator } from '../src/orchestrator/kubernetes/kubernetes.orchestrator';
import { KubernetesSettings } from '../src/orchestrator/kubernetes/kubernetes.settings';
import { LABELS, accountNamespace } from '../src/orchestrator/kubernetes/naming';

const CODE: Record<Runtime, string> = {
  [Runtime.NODEJS]: `export async function handler(event: { name?: string }) {
  return { message: 'Hello ' + (event.name ?? 'world') };
}`,
  [Runtime.PYTHON]: 'def handler(event, context):\n    return {"message": "Hello " + event.get("name", "world")}\n',
};

interface Options {
  runtimeClass: string;
  runtime: Runtime;
  memory: number;
  atOnce: number;
  rounds: number;
}

function parseArgs(args: string[]): Options {
  const options: Options = { runtimeClass: '', runtime: Runtime.NODEJS, memory: 128, atOnce: 3, rounds: 2 };
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i], args[i + 1] ?? ''];
    if (name === '--runtime-class') options.runtimeClass = value;
    else if (name === '--runtime' && (Object.values(Runtime) as string[]).includes(value)) options.runtime = value as Runtime;
    else if (name === '--memory' && Number(value) >= 128) options.memory = Number(value);
    else if (name === '--at-once' && Number(value) >= 1 && Number(value) <= 6) options.atOnce = Number(value);
    else if (name === '--rounds' && Number(value) >= 1) options.rounds = Number(value);
    else throw new Error(`Unknown or bad argument ${name} ${value}: see the usage at the top of scripts/cold-start-benchmark.ts`);
  }
  return options;
}

interface Pod {
  metadata: { creationTimestamp: string };
  status: { containerStatuses?: Array<{ state?: { running?: { startedAt: string } } }> };
}

interface Timing {
  deployToReadyMs: number;
  firstCallMs: number;
  createdToStartedS: number;
  startedToListeningS: number;
  listeningToLoadedS: number;
}

/** The pod's own view, from kubectl (admin): its creation, its container's start (seconds), and its runtime's log lines (ms). */
function podTiming(ns: string, fn: FunctionWorkload): Omit<Timing, 'deployToReadyMs' | 'firstCallMs'> {
  const selector = `${LABELS.functionId}=${fn.id}`;
  const pod = (JSON.parse(execFileSync('kubectl', ['-n', ns, 'get', 'pods', '-l', selector, '-o', 'json'], { encoding: 'utf8' })) as { items: Pod[] }).items[0];
  const log = execFileSync('kubectl', ['-n', ns, 'logs', '-l', selector, '--tail', '-1'], { encoding: 'utf8' });
  const at = (message: string) => {
    for (const line of log.split('\n')) {
      try {
        const entry = JSON.parse(line) as { msg?: string; message?: string; time?: string; timestamp?: string };
        if ((entry.msg ?? entry.message) === message) return Date.parse(entry.time ?? entry.timestamp ?? '');
      } catch {
        // a line of the function's own output
      }
    }
    return NaN;
  };
  const created = Date.parse(pod.metadata.creationTimestamp);
  const started = Date.parse(pod.status.containerStatuses?.[0]?.state?.running?.startedAt ?? '');
  const listening = at('runtime listening');
  const loaded = at('function initialized');
  return {
    createdToStartedS: (started - created) / 1000,
    startedToListeningS: (listening - started) / 1000,
    listeningToLoadedS: (loaded - listening) / 1000,
  };
}

async function round(orchestrator: KubernetesOrchestrator, ns: string, accountId: string, options: Options): Promise<Timing[]> {
  const fns: FunctionWorkload[] = Array.from({ length: options.atOnce }, (_, i) => ({
    id: randomUUID(),
    name: `cold-start-${i}`,
    accountId,
    runtime: options.runtime,
    code: CODE[options.runtime],
    memory: options.memory,
    timeout: 3,
    minInstances: 0,
    maxInstances: 1,
    eventFormat: EventFormat.LAMBDA,
  }));
  const tenant = { quota: { pods: 10, cpu: '8', memory: '8Gi' }, internetEgress: false };
  try {
    return await Promise.all(
      fns.map(async (fn) => {
        const start = Date.now();
        await orchestrator.deploy(fn, tenant);
        await orchestrator.waitUntilReady(fn, 120_000);
        const ready = Date.now();
        await orchestrator.invoke(fn, { name: 'benchmark' });
        return { deployToReadyMs: ready - start, firstCallMs: Date.now() - ready, ...podTiming(ns, fn) };
      }),
    );
  } finally {
    for (const fn of fns) await orchestrator.remove(fn).catch(() => undefined);
  }
}

const seconds = (value: number) => (Number.isFinite(value) ? value.toFixed(1).padStart(6) : '     ?');

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const kubeDir = path.resolve(__dirname, '../../hack/.kube');
  const settings: KubernetesSettings = {
    apiUrl: process.env.K8S_API_URL ?? 'https://127.0.0.1:6550',
    tokenFile: process.env.K8S_TOKEN_FILE ?? path.join(kubeDir, 'ff-controller.token'),
    caFile: process.env.K8S_CA_FILE ?? path.join(kubeDir, 'ca.crt'),
    invokeMode: 'proxy',
    namespacePrefix: 'ff-t-',
    // Another image can be measured against the current one, as the backend would be set.
    runtimeImages: {
      nodejs: process.env.K8S_RUNTIME_IMAGE_NODEJS ?? 'ff-runtime-nodejs:24-v3',
      python: process.env.K8S_RUNTIME_IMAGE_PYTHON ?? 'ff-runtime-python:3.13-v3',
    },
    imagePullPolicy: 'IfNotPresent',
    runtimeClass: options.runtimeClass,
    readyTimeoutSeconds: 120,
    egressInternet: false,
    ingressAllowCidrs: [],
    logStoreDeleteKeyFile: '/nonexistent',
  };
  const client = new KubeClient({ server: settings.apiUrl, tokenFile: settings.tokenFile, caFile: settings.caFile });
  const orchestrator = new KubernetesOrchestrator(settings, client);
  const accountId = `cold-start-${randomUUID()}`;
  const ns = accountNamespace(settings.namespacePrefix, accountId);
  console.log(
    `${options.runtime}, ${options.memory} MB, ${options.atOnce} at once, ${options.rounds} round(s), ` +
      `${options.runtimeClass ? `RuntimeClass ${options.runtimeClass}` : 'no RuntimeClass'}, ${settings.runtimeImages[options.runtime]}, in ${ns}. Seconds:\n`,
  );
  console.log('round  deploy→Ready  first call  created→started  started→listening  listening→loaded');
  const all: Timing[] = [];
  try {
    for (let r = 1; r <= options.rounds; r++) {
      for (const t of await round(orchestrator, ns, accountId, options)) {
        all.push(t);
        console.log(
          `${String(r).padStart(5)}  ${seconds(t.deployToReadyMs / 1000)}        ${seconds(t.firstCallMs / 1000)}      ${seconds(t.createdToStartedS)}           ${seconds(t.startedToListeningS)}             ${seconds(t.listeningToLoadedS)}`,
        );
      }
    }
  } finally {
    await client.delete(paths.namespace(ns)).catch(() => undefined);
  }
  const worst = (pick: (t: Timing) => number) => Math.max(...all.map(pick).filter(Number.isFinite));
  console.log(`\nworst: deploy→Ready ${(worst((t) => t.deployToReadyMs) / 1000).toFixed(1)} s, listening→loaded ${worst((t) => t.listeningToLoadedS).toFixed(1)} s`);
}

main().catch((error: unknown) => {
  console.error(`cold-start benchmark could not run: ${describeError(error)}`);
  process.exit(1);
});

/**
 * FF Node.js runtime, protocol v2. The main thread serves HTTP and supervises
 * one worker thread that runs user code (worker.ts):
 *
 *   GET  /healthz   liveness: the main thread is responsive
 *   GET  /readyz    readiness: user code is loaded (503 with the error if not)
 *   POST /invoke    run the handler once; invocations are serialized, as on Lambda
 *
 * A timeout, out-of-memory, or crash terminates the worker and starts a fresh
 * one, so even CPU-bound infinite loops are stopped and probes keep answering.
 * If that fresh worker can't load code that loaded before, the process exits,
 * so that Kubernetes restarts the container. Environment variables are never logged.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { FunctionError, FunctionEvent, WorkerConfig, WorkerMessage } from './protocol';
import { OutputRelay } from './relay';

type ResultMessage = Extract<WorkerMessage, { type: 'result' }>;

const env = process.env;
const port = Number(env.PORT ?? 8080);
const timeoutMs = Number(env.FUNCTION_TIMEOUT ?? 30_000);
const memoryLimitMb = Number(env.FUNCTION_MEMORY_LIMIT ?? 128);
const initTimeoutMs = Number(env.FF_INIT_TIMEOUT_MS ?? Math.max(10_000, timeoutMs));
const maxQueue = Number(env.FF_MAX_QUEUE ?? 32);
/**
 * How long a call may wait for the instance to be free. Then it gets 429, as on Lambda when no
 * environment is free. The backend waits this long plus the timeout, so it never gives up on
 * a call that is only queued (client-readiness plan, P-06).
 */
const maxQueueWaitMs = Number(env.FF_MAX_QUEUE_WAIT_MS ?? timeoutMs);
/** AWS Lambda's synchronous request and response limit. */
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;
const MB = 1024 * 1024;
/** This thread's steady-state memory in the image. At start-up the container reads less. */
const MAIN_THREAD_MB = 35;
/** What a worker needs besides its heap: the isolate, Node's environment, and TypeScript for `.ts` code. */
const WORKER_BASELINE_MB = 12;
/** Room for this thread's share of an invocation (6 MB requests and replies, held more than once) and for Buffers, which V8's heap limits do not cover. */
const MARGIN_MB = 16;
const MIN_HEAP_MB = 32;
/**
 * How long END waits for the worker's end-of-call markers (protocol.ts) once the result has come: they
 * come within a millisecond unless work the handler left running blocks the worker. It must stay under
 * the 2 s the backend allows past a call's queue wait and timeout (kubernetes.orchestrator.ts).
 */
const OUTPUT_WAIT_MS = 1000;

/** The container's memory limit and use (cgroup v2), where this process runs in one. */
function containerMemoryMb(): { limitMb?: number; inUseMb?: number } {
  try {
    const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const inUseMb = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8')) / MB;
    return { limitMb: max === 'max' ? undefined : Number(max) / MB, inUseMb };
  } catch {
    return {};
  }
}

/**
 * V8 heap limits for every worker. On Kubernetes the container limit equals the function's
 * memory, and reaching it gets the whole container killed (repeatedly: CrashLoopBackOff),
 * whereas a full heap only ends the worker, reported as Runtime.OutOfMemory. So the heap gets
 * the function's memory (or the container limit, if lower) minus what this thread uses, a
 * worker's baseline, and a margin. Measured once at start: after an out-of-memory, the old
 * worker's heap is still being freed when its replacement starts.
 */
const heapLimits = ((): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number } => {
  const { limitMb, inUseMb } = containerMemoryMb();
  const totalMb = limitMb === undefined ? memoryLimitMb : Math.min(memoryLimitMb, limitMb);
  const usedMb = Math.max(inUseMb ?? 0, MAIN_THREAD_MB);
  const heapMb = Math.max(MIN_HEAP_MB, Math.floor(totalMb - usedMb - WORKER_BASELINE_MB - MARGIN_MB));
  const youngMb = Math.max(2, Math.min(16, Math.floor(heapMb / 8)));
  return { maxOldGenerationSizeMb: heapMb - youngMb, maxYoungGenerationSizeMb: youngMb };
})();

const workerConfig: WorkerConfig = {
  taskRoot: env.LAMBDA_TASK_ROOT ?? '/var/task',
  handler: env.FF_HANDLER ?? 'function.handler',
  functionName: env.FUNCTION_NAME ?? 'unknown',
  functionVersion: env.FUNCTION_VERSION ?? '$LATEST',
  memoryLimitMb,
};

// As on AWS Lambda, the function runs in its task root, so relative paths find the
// files next to its code. Worker threads can't change directory, and share this one.
try {
  process.chdir(workerConfig.taskRoot);
} catch {
  // A missing task root is reported when the worker loads the code.
}

interface Invocation {
  id: number;
  requestId: string;
  event: FunctionEvent;
  res: http.ServerResponse;
  startedAt?: number;
  /** When the handler settled: the call's duration ends here, not when its output is all forwarded. */
  endedAt?: number;
  durationMs?: number;
  timer?: NodeJS.Timeout;
  /** The handler's result, held until the call's output is all forwarded. */
  result?: ResultMessage;
  /** The worker's streams whose end-of-call marker came: END waits for both, OUTPUT_WAIT_MS at most. */
  outputEnded?: Set<'stdout' | 'stderr'>;
  outputTimer?: NodeJS.Timeout;
  /** Answers 429 if the call is still queued after maxQueueWaitMs. */
  queueTimer?: NodeJS.Timeout;
}

let worker: Worker | undefined;
/** Incremented whenever a worker is replaced; events from older workers are ignored. */
let generation = 0;
let state: 'starting' | 'ready' | 'failed' = 'starting';
/** The code has loaded at least once: a later load failure is a broken environment, not broken code. */
let everReady = false;
let initError: FunctionError | undefined;
let initTimer: NodeJS.Timeout | undefined;
let current: Invocation | undefined;
const queue: Invocation[] = [];
let nextId = 1;
let shuttingDown = false;
/** The current worker's stdout, forwarded by this thread: the runtime's own lines start a line of their own. */
let stdoutRelay: OutputRelay | undefined;

/** One of the runtime's own lines, after any line the user's output left open. */
function line(text: string): void {
  stdoutRelay?.endLine();
  console.log(text);
}

function log(fields: Record<string, unknown>): void {
  line(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

/** The runtime's peak resident memory since it started, all threads together, as Lambda's "Max Memory Used". */
function maxMemoryUsedMb(): number {
  return Math.max(1, Math.round(process.resourceUsage().maxRSS / 1024)); // maxRSS is in KiB
}

function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.writableEnded || res.destroyed) return; // the client gave up
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, value: unknown, headers?: Record<string, string>): void {
  send(res, status, JSON.stringify(value), headers);
}

function invocationHeaders(inv: Invocation): Record<string, string> {
  return {
    'x-ff-request-id': inv.requestId,
    'x-ff-duration-ms': (inv.durationMs ?? 0).toFixed(2),
    'x-ff-max-memory-used-mb': String(maxMemoryUsedMb()),
  };
}

function respondError(inv: Invocation, status: number, error: FunctionError): void {
  sendJson(inv.res, status, error, { ...invocationHeaders(inv), 'x-ff-function-error': 'Unhandled' });
}

function startWorker(): void {
  const gen = ++generation;
  state = 'starting';
  initError = undefined;
  // The worker's output comes to this thread, which forwards it: only then can END follow a call's last line.
  const w = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: workerConfig,
    resourceLimits: heapLimits,
    stdout: true,
    stderr: true,
  });
  worker = w;
  const relays = {
    stdout: new OutputRelay(process.stdout, (id) => gen === generation && onEndOfCall(id, 'stdout')),
    stderr: new OutputRelay(process.stderr, (id) => gen === generation && onEndOfCall(id, 'stderr')),
  };
  stdoutRelay = relays.stdout;
  for (const name of ['stdout', 'stderr'] as const) {
    const stream = w[name];
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => relays[name].write(chunk));
    stream.on('end', () => relays[name].flush());
  }
  w.on('message', (message: WorkerMessage) => gen === generation && onMessage(message));
  w.on('error', (err: NodeJS.ErrnoException) => {
    if (gen !== generation) return;
    onCrash(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'Runtime.OutOfMemory' : 'Runtime.ExitError', err.message);
  });
  w.on('exit', (code) => {
    if (gen === generation) onCrash('Runtime.ExitError', `Runtime exited with error: exit status ${code}`);
  });
  clearTimeout(initTimer);
  initTimer = setTimeout(() => {
    if (gen !== generation || state !== 'starting') return;
    generation++;
    void w.terminate();
    fail({ errorType: 'Sandbox.Timedout', errorMessage: `Init phase timed out after ${(initTimeoutMs / 1000).toFixed(2)} seconds` });
  }, initTimeoutMs);
}

function replaceWorker(): void {
  const old = worker;
  generation++;
  worker = undefined;
  void old?.terminate();
  if (!shuttingDown) startWorker();
}

/**
 * User code cannot be loaded: report it on /readyz and to every caller. If it
 * loaded before, the code is fine and this environment is not (a reload that
 * timed out at 0.1 CPU, for example). /readyz would stay 503 while /healthz
 * stays 200, so kubelet would never restart the container: exit instead.
 */
function fail(error: FunctionError): void {
  clearTimeout(initTimer);
  state = 'failed';
  initError = error;
  log({ level: 'error', msg: 'function initialization failed', ...error });
  const pending = current ? [current, ...queue] : [...queue];
  queue.length = 0;
  current = undefined;
  for (const inv of pending) {
    if (inv.timer) clearTimeout(inv.timer);
    if (inv.queueTimer) clearTimeout(inv.queueTimer);
    clearTimeout(inv.outputTimer);
    respondError(inv, 500, error);
  }
  if (everReady) {
    log({ level: 'error', msg: 'function reload failed; exiting so the container restarts', ...error });
    server.close();
    setTimeout(() => process.exit(1), 200); // let the answers above reach their callers
  }
}

function onMessage(message: WorkerMessage): void {
  if (message.type === 'ready') {
    clearTimeout(initTimer);
    state = 'ready';
    everReady = true;
    log({ level: 'info', msg: 'function initialized', handler: workerConfig.handler });
    dispatch();
  } else if (message.type === 'init_error') {
    fail({ errorType: message.errorType, errorMessage: message.errorMessage });
  } else if (current && current.id === message.id && !current.result) {
    // The handler has settled: no timeout from now on. END waits for the call's output, whose end the worker marks.
    const inv = current;
    clearTimeout(inv.timer);
    inv.endedAt = performance.now();
    inv.result = message;
    if (inv.outputEnded?.size === 2) settle(inv);
    else inv.outputTimer = setTimeout(() => settle(inv), OUTPUT_WAIT_MS);
  }
}

/** A worker stream's end-of-call marker: everything the call wrote to that stream is forwarded. */
function onEndOfCall(id: number, stream: 'stdout' | 'stderr'): void {
  const inv = current;
  if (!inv || inv.id !== id) return; // a marker that came after its call's wait ended
  (inv.outputEnded ??= new Set()).add(stream);
  if (inv.result && inv.outputEnded.size === 2) settle(inv);
}

/** Completes a call whose result came, and starts the next one. */
function settle(inv: Invocation): void {
  if (current !== inv) return;
  complete(inv);
  dispatch();
}

/** A call whose result came, once its output is in the log: its error line, END and REPORT, then its answer. */
function complete(inv: Invocation): void {
  const message = inv.result!;
  if (!message.ok && message.stackTrace) {
    // The handler threw: the same line as the Python runtime writes, before END.
    log({
      level: 'error',
      msg: 'function error',
      requestId: inv.requestId,
      errorType: message.errorType,
      errorMessage: message.errorMessage,
      stackTrace: message.stackTrace,
    });
  }
  finish(inv);
  if (!message.ok) {
    respondError(inv, 500, { errorType: message.errorType, errorMessage: message.errorMessage });
  } else if (typeof message.body !== 'string') {
    // The worker never sends anything else; this keeps a bad message from crashing this thread.
    respondError(inv, 500, { errorType: 'Runtime.MarshalError', errorMessage: 'Unable to marshal response' });
  } else if (Buffer.byteLength(message.body) > MAX_PAYLOAD_BYTES) {
    respondError(inv, 500, {
      errorType: 'Function.ResponseSizeTooLarge',
      errorMessage: `Response payload size exceeded maximum allowed payload size (${MAX_PAYLOAD_BYTES} bytes)`,
    });
  } else {
    send(inv.res, 200, message.body, invocationHeaders(inv));
  }
}

function onCrash(errorType: string, errorMessage: string): void {
  if (state === 'failed') return;
  if (state === 'starting') {
    fail({ errorType, errorMessage }); // died while loading user code
    return;
  }
  let inv = current;
  if (inv?.result) {
    // The handler had returned, and its call keeps its answer: what crashed is work it left running.
    complete(inv);
    inv = undefined;
  }
  log({ level: 'error', msg: 'function worker crashed; restarting', errorType, errorMessage, requestId: inv?.requestId });
  if (inv) {
    finish(inv);
    respondError(inv, 500, { errorType, errorMessage });
  }
  replaceWorker();
}

function finish(inv: Invocation): void {
  if (inv.timer) clearTimeout(inv.timer);
  clearTimeout(inv.outputTimer);
  if (current === inv) current = undefined;
  inv.durationMs = inv.startedAt === undefined ? 0 : (inv.endedAt ?? performance.now()) - inv.startedAt;
  line(`END RequestId: ${inv.requestId}`);
  line(
    `REPORT RequestId: ${inv.requestId}\tDuration: ${inv.durationMs.toFixed(2)} ms\t` +
      `Billed Duration: ${Math.ceil(inv.durationMs)} ms\tMemory Size: ${memoryLimitMb} MB\t` +
      `Max Memory Used: ${maxMemoryUsedMb()} MB`,
  );
}

function onTimeout(inv: Invocation): void {
  if (current !== inv) return;
  finish(inv);
  log({ level: 'error', msg: 'task timed out; restarting worker', requestId: inv.requestId, timeoutMs });
  respondError(inv, 504, {
    errorType: 'Sandbox.Timedout',
    errorMessage: `Task timed out after ${(timeoutMs / 1000).toFixed(2)} seconds`,
  });
  replaceWorker();
}

function dispatch(): void {
  if (current || state !== 'ready' || !worker) return;
  let inv = queue.shift();
  while (inv && inv.res.destroyed) {
    clearTimeout(inv.queueTimer);
    inv = queue.shift(); // callers that gave up while queued
  }
  if (!inv) {
    if (shuttingDown) process.exit(0);
    return;
  }
  clearTimeout(inv.queueTimer);
  current = inv;
  inv.startedAt = performance.now();
  line(`START RequestId: ${inv.requestId} Version: ${workerConfig.functionVersion}`);
  const target = inv;
  inv.timer = setTimeout(() => onTimeout(target), timeoutMs);
  worker.postMessage({ type: 'invoke', id: inv.id, requestId: inv.requestId, event: inv.event, deadlineMs: Date.now() + timeoutMs });
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_PAYLOAD_BYTES) chunks.push(chunk);
      else if (size > 2 * MAX_PAYLOAD_BYTES) req.destroy(); // stop draining abusive uploads
    });
    req.on('end', () => resolve(size > MAX_PAYLOAD_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(',') : value;
  }
  return flat;
}

async function acceptInvocation(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const raw = await readBody(req);
  if (raw === null) {
    sendJson(res, 413, {
      errorType: 'RequestEntityTooLargeException',
      errorMessage: `Request must be smaller than ${MAX_PAYLOAD_BYTES} bytes`,
    });
    return;
  }
  let body: unknown = {};
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errorType: 'InvalidRequestContentException', errorMessage: 'Could not parse request body into json' });
      return;
    }
  }
  if (state === 'failed' && initError) {
    sendJson(res, 500, initError, { 'x-ff-function-error': 'Unhandled' });
    return;
  }
  if (shuttingDown) {
    sendJson(res, 503, { errorType: 'ServiceUnavailableException', errorMessage: 'Runtime is shutting down' });
    return;
  }
  if (queue.length >= maxQueue) {
    sendJson(res, 429, { errorType: 'TooManyRequestsException', errorMessage: 'Rate exceeded' });
    return;
  }
  const header = req.headers['x-ff-request-id'];
  const inv: Invocation = {
    id: nextId++,
    requestId: (Array.isArray(header) ? header[0] : header) || randomUUID(),
    res,
    event: {
      body,
      headers: flattenHeaders(req.headers),
      method: req.method ?? 'POST',
      query: Object.fromEntries(url.searchParams),
      path: url.pathname,
    },
  };
  inv.queueTimer = setTimeout(() => expireQueued(inv), maxQueueWaitMs);
  queue.push(inv);
  dispatch();
}

/** A call that waited maxQueueWaitMs without the instance becoming free: 429, as on Lambda. */
function expireQueued(inv: Invocation): void {
  const index = queue.indexOf(inv);
  if (index === -1) return; // it started, or was answered
  queue.splice(index, 1);
  sendJson(inv.res, 429, {
    errorType: 'TooManyRequestsException',
    errorMessage: `Rate exceeded: no instance was free within ${(maxQueueWaitMs / 1000).toFixed(2)} seconds`,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://runtime');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
  } else if (req.method === 'GET' && url.pathname === '/readyz') {
    if (state === 'ready') sendJson(res, 200, { status: 'ready' });
    else sendJson(res, 503, initError ? { status: state, error: initError } : { status: state });
  } else if (req.method === 'POST' && url.pathname === '/invoke') {
    acceptInvocation(req, res, url).catch((err: Error) => {
      sendJson(res, 400, { errorType: 'InvalidRequestContentException', errorMessage: err.message });
    });
  } else {
    sendJson(res, 404, { errorType: 'ResourceNotFoundException', errorMessage: `No route for ${req.method} ${url.pathname}` });
  }
});

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ level: 'info', msg: 'shutting down; draining invocations', signal, inFlight: Number(Boolean(current)), queued: queue.length });
  server.close();
  if (!current && queue.length === 0) process.exit(0);
  setTimeout(() => process.exit(0), timeoutMs + 1_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startWorker();
server.listen(port, () => {
  log({
    level: 'info',
    msg: 'runtime listening',
    port,
    timeoutMs,
    maxQueueWaitMs,
    memoryLimitMb,
    heapLimitMb: heapLimits.maxOldGenerationSizeMb + heapLimits.maxYoungGenerationSizeMb,
    handler: workerConfig.handler,
    protocol: 2,
  });
});

/**
 * FF Node.js runtime, protocol v1. The main thread serves HTTP and supervises
 * one worker thread that runs user code (worker.ts):
 *
 *   GET  /healthz   liveness: the main thread is responsive
 *   GET  /readyz    readiness: user code is loaded (503 with the error if not)
 *   POST /invoke    run the handler once; invocations are serialized, as on Lambda
 *
 * A timeout, out-of-memory, or crash terminates the worker and starts a fresh
 * one, so even CPU-bound infinite loops are stopped and probes keep answering.
 * Environment variables are never logged.
 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { FunctionError, FunctionEvent, WorkerConfig, WorkerMessage } from './protocol';

const env = process.env;
const port = Number(env.PORT ?? 8080);
const timeoutMs = Number(env.FUNCTION_TIMEOUT ?? 30_000);
const memoryLimitMb = Number(env.FUNCTION_MEMORY_LIMIT ?? 128);
const initTimeoutMs = Number(env.FF_INIT_TIMEOUT_MS ?? Math.max(10_000, timeoutMs));
const maxQueue = Number(env.FF_MAX_QUEUE ?? 32);
/** AWS Lambda's synchronous request and response limit. */
const MAX_PAYLOAD_BYTES = 6 * 1024 * 1024;

const workerConfig: WorkerConfig = {
  taskRoot: env.LAMBDA_TASK_ROOT ?? '/var/task',
  handler: env.FF_HANDLER ?? 'function.handler',
  functionName: env.FUNCTION_NAME ?? 'unknown',
  functionVersion: env.FUNCTION_VERSION ?? '$LATEST',
  memoryLimitMb,
};

interface Invocation {
  id: number;
  requestId: string;
  event: FunctionEvent;
  res: http.ServerResponse;
  startedAt?: number;
  durationMs?: number;
  timer?: NodeJS.Timeout;
}

let worker: Worker | undefined;
/** Incremented whenever a worker is replaced; events from older workers are ignored. */
let generation = 0;
let state: 'starting' | 'ready' | 'failed' = 'starting';
let initError: FunctionError | undefined;
let initTimer: NodeJS.Timeout | undefined;
let current: Invocation | undefined;
const queue: Invocation[] = [];
let nextId = 1;
let shuttingDown = false;

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}

function maxMemoryUsedMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
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
  const w = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: workerConfig,
    resourceLimits: { maxOldGenerationSizeMb: Math.max(16, Math.floor(memoryLimitMb * 0.8)) },
  });
  worker = w;
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

/** User code cannot be loaded: report it on /readyz and to every caller. */
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
    respondError(inv, 500, error);
  }
}

function onMessage(message: WorkerMessage): void {
  if (message.type === 'ready') {
    clearTimeout(initTimer);
    state = 'ready';
    log({ level: 'info', msg: 'function initialized', handler: workerConfig.handler });
    dispatch();
  } else if (message.type === 'init_error') {
    fail({ errorType: message.errorType, errorMessage: message.errorMessage });
  } else if (current && current.id === message.id) {
    const inv = current;
    finish(inv);
    if (!message.ok) {
      respondError(inv, 500, { errorType: message.errorType, errorMessage: message.errorMessage });
    } else if (Buffer.byteLength(message.body) > MAX_PAYLOAD_BYTES) {
      respondError(inv, 500, {
        errorType: 'Function.ResponseSizeTooLarge',
        errorMessage: `Response payload size exceeded maximum allowed payload size (${MAX_PAYLOAD_BYTES} bytes)`,
      });
    } else {
      send(inv.res, 200, message.body, invocationHeaders(inv));
    }
    dispatch();
  }
}

function onCrash(errorType: string, errorMessage: string): void {
  if (state === 'failed') return;
  if (state === 'starting') {
    fail({ errorType, errorMessage }); // died while loading user code
    return;
  }
  const inv = current;
  log({ level: 'error', msg: 'function worker crashed; restarting', errorType, errorMessage, requestId: inv?.requestId });
  if (inv) {
    finish(inv);
    respondError(inv, 500, { errorType, errorMessage });
  }
  replaceWorker();
}

function finish(inv: Invocation): void {
  if (inv.timer) clearTimeout(inv.timer);
  if (current === inv) current = undefined;
  inv.durationMs = inv.startedAt === undefined ? 0 : performance.now() - inv.startedAt;
  console.log(`END RequestId: ${inv.requestId}`);
  console.log(
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
  while (inv && inv.res.destroyed) inv = queue.shift(); // callers that gave up while queued
  if (!inv) {
    if (shuttingDown) process.exit(0);
    return;
  }
  current = inv;
  inv.startedAt = performance.now();
  console.log(`START RequestId: ${inv.requestId} Version: ${workerConfig.functionVersion}`);
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
  queue.push({
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
  });
  dispatch();
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
  log({ level: 'info', msg: 'runtime listening', port, timeoutMs, memoryLimitMb, handler: workerConfig.handler, protocol: 1 });
});

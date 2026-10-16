// L1 tests for the runtime protocol: each test starts `node dist/main.js`
// against one fixture on a random port. No Docker needed. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = new Set();

after(async () => {
  for (const runtime of running) await runtime.stop();
});

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRuntime(fixture, env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(root, 'dist/main.js')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      LAMBDA_TASK_ROOT: path.join(root, 'test/fixtures', fixture),
      FUNCTION_NAME: fixture,
      FUNCTION_TIMEOUT: '1000',
      FUNCTION_MEMORY_LIMIT: '128',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', (chunk) => (logs += chunk));
  proc.stderr.on('data', (chunk) => (logs += chunk));
  const base = `http://127.0.0.1:${port}`;
  const runtime = {
    base,
    logs: () => logs,
    async stop() {
      running.delete(runtime);
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await once(proc, 'exit');
      }
    },
  };
  running.add(runtime);
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return runtime;
    } catch {
      // not listening yet
    }
    await sleep(50);
  }
  throw new Error(`runtime for ${fixture} did not start:\n${logs}`);
}

async function readyzUntil(runtime, predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    const res = await fetch(`${runtime.base}/readyz`);
    last = { status: res.status, body: await res.json() };
    if (predicate(last)) return last;
    await sleep(50);
  }
  assert.fail(`readyz never reached the expected state; last: ${JSON.stringify(last)}`);
}

const readyz = (runtime, expected, timeoutMs) => readyzUntil(runtime, (r) => r.status === expected, timeoutMs);

async function invoke(runtime, body, headers = {}) {
  const res = await fetch(`${runtime.base}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : undefined };
}

describe('successful invocations', () => {
  it('runs a TypeScript handler with event, context and Lambda-style logs', async () => {
    const rt = await startRuntime('hello');
    await readyz(rt, 200);

    const res = await invoke(rt, { name: 'FF' }, { 'x-ff-request-id': 'req-123' });

    assert.equal(res.status, 200);
    assert.equal(res.json.message, 'Hello FF');
    assert.equal(res.json.functionName, 'hello');
    assert.equal(res.json.memoryLimitInMB, '128');
    assert.equal(res.json.requestId, 'req-123');
    assert.ok(res.json.remainingMs > 0 && res.json.remainingMs <= 1000, `remainingMs=${res.json.remainingMs}`);
    assert.equal(res.headers.get('x-ff-request-id'), 'req-123');
    assert.ok(Number(res.headers.get('x-ff-duration-ms')) >= 0);
    assert.ok(Number(res.headers.get('x-ff-max-memory-used-mb')) > 0);
    assert.equal(res.headers.get('x-ff-function-error'), null);
    assert.match(rt.logs(), /START RequestId: req-123 Version: \$LATEST/);
    assert.match(rt.logs(), /END RequestId: req-123/);
    assert.match(rt.logs(), /REPORT RequestId: req-123\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 128 MB/);
    await rt.stop();
  });

  it('runs a plain JavaScript handler and generates a request ID when none is given', async () => {
    const rt = await startRuntime('js-function');
    await readyz(rt, 200);

    const res = await invoke(rt, { a: 1 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { js: true, echo: { a: 1 } });
    assert.match(res.headers.get('x-ff-request-id'), /^[0-9a-f-]{36}$/);
    await rt.stop();
  });

  it('returns JSON null when the handler returns nothing', async () => {
    const rt = await startRuntime('void');
    await readyz(rt, 200);

    const res = await invoke(rt, {});

    assert.equal(res.status, 200);
    assert.equal(res.text, 'null');
    await rt.stop();
  });

  it('treats an empty request body as {}', async () => {
    const rt = await startRuntime('js-function');
    await readyz(rt, 200);

    const res = await invoke(rt, '');

    assert.deepEqual(res.json.echo, {});
    await rt.stop();
  });

  it('serializes concurrent invocations: one at a time, as on Lambda', async () => {
    const rt = await startRuntime('slow-echo');
    await readyz(rt, 200);

    const [first, second] = await Promise.all([invoke(rt, { n: 1 }), invoke(rt, { n: 2 })]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const [a, b] = [first.json, second.json].sort((x, y) => x.start - y.start);
    assert.ok(b.start >= a.end, `overlap: ${JSON.stringify([a, b])}`);
    await rt.stop();
  });
});

describe('function errors', () => {
  it('maps a thrown error to 500 with errorType and errorMessage', async () => {
    const rt = await startRuntime('throws');
    await readyz(rt, 200);

    const res = await invoke(rt, {});

    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { errorType: 'TypeError', errorMessage: 'bad input' });
    assert.equal(res.headers.get('x-ff-function-error'), 'Unhandled');
    await rt.stop();
  });

  it('rejects responses above 6 MB with Function.ResponseSizeTooLarge', async () => {
    const rt = await startRuntime('big-response');
    await readyz(rt, 200);

    const res = await invoke(rt, {});

    assert.equal(res.status, 500);
    assert.equal(res.json.errorType, 'Function.ResponseSizeTooLarge');
    await rt.stop();
  });
});

describe('timeouts and crashes recycle the worker', () => {
  it('times out an async handler with Sandbox.Timedout', async () => {
    const rt = await startRuntime('async-timeout', { FUNCTION_TIMEOUT: '500' });
    await readyz(rt, 200);

    const started = Date.now();
    const res = await invoke(rt, {});
    const elapsed = Date.now() - started;

    assert.equal(res.status, 504);
    assert.deepEqual(res.json, { errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 0.50 seconds' });
    assert.ok(elapsed >= 450 && elapsed < 1500, `elapsed=${elapsed}ms`);
    await rt.stop();
  });

  it('stops a CPU-bound infinite loop, keeps probes responsive, and recovers', async () => {
    const rt = await startRuntime('busy-loop', { FUNCTION_TIMEOUT: '700' });
    await readyz(rt, 200);

    const spinning = invoke(rt, { spin: true });
    await sleep(200);
    const health = await fetch(`${rt.base}/healthz`); // main thread must still answer
    const res = await spinning;
    await readyz(rt, 200); // a fresh worker was started
    const after = await invoke(rt, { spin: false });

    assert.equal(health.status, 200);
    assert.equal(res.status, 504);
    assert.equal(res.json.errorType, 'Sandbox.Timedout');
    assert.equal(after.status, 200);
    assert.equal(after.json, 'ok');
    await rt.stop();
  });

  it('reports out-of-memory as Runtime.OutOfMemory and recovers', async () => {
    const rt = await startRuntime('oom', { FUNCTION_MEMORY_LIMIT: '64', FUNCTION_TIMEOUT: '10000' });
    await readyz(rt, 200);

    const res = await invoke(rt, {});
    const ready = await readyz(rt, 200);

    assert.equal(res.status, 500);
    assert.equal(res.json.errorType, 'Runtime.OutOfMemory');
    assert.equal(ready.status, 200);
    await rt.stop();
  });

  it('reports process.exit() in user code as Runtime.ExitError and recovers', async () => {
    const rt = await startRuntime('exit');
    await readyz(rt, 200);

    const res = await invoke(rt, {});
    const ready = await readyz(rt, 200);

    assert.equal(res.status, 500);
    assert.equal(res.json.errorType, 'Runtime.ExitError');
    assert.match(res.json.errorMessage, /exit status 3/);
    assert.equal(ready.status, 200);
    await rt.stop();
  });
});

describe('initialization failures keep the pod unready', () => {
  const cases = [
    ['init-error', 'Runtime.ImportModuleError', /boom at init/],
    ['syntax-error', 'Runtime.UserCodeSyntaxError', /SyntaxError/],
    ['no-handler', 'Runtime.HandlerNotFound', /function\.handler is undefined/],
    ['empty', 'Runtime.ImportModuleError', /Cannot find module 'function'/],
  ];
  for (const [fixture, errorType, message] of cases) {
    it(`${fixture} → ${errorType} on /readyz and /invoke`, async () => {
      const rt = await startRuntime(fixture);

      // 503 is also returned while starting, so wait for the terminal state.
      const ready = await readyzUntil(rt, (r) => r.body.status === 'failed');
      const res = await invoke(rt, {});

      assert.equal(ready.body.status, 'failed');
      assert.equal(ready.body.error.errorType, errorType);
      assert.match(ready.body.error.errorMessage, message);
      assert.equal(res.status, 500);
      assert.equal(res.json.errorType, errorType);
      await rt.stop();
    });
  }

  it('fails initialization that never finishes with Sandbox.Timedout', async () => {
    const rt = await startRuntime('init-hang', { FF_INIT_TIMEOUT_MS: '500' });

    const health = await fetch(`${rt.base}/healthz`); // the hang is confined to the worker
    const failed = await readyzUntil(rt, (r) => r.body.status === 'failed', 3000);

    assert.equal(health.status, 200);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.errorType, 'Sandbox.Timedout');
    assert.match(failed.body.error.errorMessage, /Init phase timed out after 0\.50 seconds/);
    await rt.stop();
  });
});

describe('request validation and limits', () => {
  it('rejects bodies above 6 MB with 413', async () => {
    const rt = await startRuntime('js-function');
    await readyz(rt, 200);

    const res = await invoke(rt, JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024 + 1) }));

    assert.equal(res.status, 413);
    assert.equal(res.json.errorType, 'RequestEntityTooLargeException');
    await rt.stop();
  });

  it('rejects invalid JSON with 400 InvalidRequestContentException', async () => {
    const rt = await startRuntime('js-function');
    await readyz(rt, 200);

    const res = await invoke(rt, '{not json');

    assert.equal(res.status, 400);
    assert.equal(res.json.errorType, 'InvalidRequestContentException');
    await rt.stop();
  });

  it('returns 429 when the queue is full', async () => {
    const rt = await startRuntime('slow-echo', { FF_MAX_QUEUE: '1' });
    await readyz(rt, 200);

    // One runs, one waits in the queue, the third overflows it.
    const results = await Promise.all([invoke(rt, { n: 1 }), invoke(rt, { n: 2 }), invoke(rt, { n: 3 })]);
    const statuses = results.map((r) => r.status).sort();

    assert.deepEqual(statuses, [200, 200, 429]);
    await rt.stop();
  });

  it('answers unknown routes with 404', async () => {
    const rt = await startRuntime('js-function');

    const res = await fetch(`${rt.base}/nope`);

    assert.equal(res.status, 404);
    await rt.stop();
  });
});

describe('secrets hygiene', () => {
  it('never writes environment variables to the logs', async () => {
    const sentinel = 's3cr3t-value-7f1d';
    const rt = await startRuntime('hello', { DATABASE_PASSWORD: sentinel });
    await readyz(rt, 200);

    await invoke(rt, { name: 'x' });

    assert.ok(!rt.logs().includes(sentinel), 'an environment value leaked into the logs');
    await rt.stop();
  });
});

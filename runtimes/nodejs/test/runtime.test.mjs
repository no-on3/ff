// L1 tests for the runtime protocol: each test starts `node dist/main.js`
// against one fixture on a random port. No Docker needed. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

/**
 * Starts the runtime on a fixture. With `oneFile`, its stdout and stderr are one file, as `2>&1` would make
 * them: the lines keep the order in which the runtime wrote them, across the two streams.
 */
async function startRuntime(fixture, env = {}, { oneFile = false } = {}) {
  const port = await freePort();
  const dir = oneFile ? fs.mkdtempSync(path.join(os.tmpdir(), 'ff-runtime-test-')) : undefined;
  const fd = dir ? fs.openSync(path.join(dir, 'output.log'), 'w') : undefined;
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
    stdio: dir ? ['ignore', fd, fd] : ['ignore', 'pipe', 'pipe'],
  });
  if (fd !== undefined) fs.closeSync(fd);
  let logs = '';
  let stdout = '';
  proc.stdout?.on('data', (chunk) => {
    logs += chunk;
    stdout += chunk;
  });
  proc.stderr?.on('data', (chunk) => (logs += chunk));
  const base = `http://127.0.0.1:${port}`;
  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));
  const runtime = {
    base,
    logs: () => (dir ? fs.readFileSync(path.join(dir, 'output.log'), 'utf8') : logs),
    /** What the runtime wrote to stdout alone. Not with `oneFile`. */
    stdout: () => stdout,
    /** The exit code once the process exits, or 'running' after waitMs. */
    exitCode: (waitMs) => Promise.race([exited, sleep(waitMs).then(() => 'running')]),
    async stop() {
      running.delete(runtime);
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await once(proc, 'exit');
      }
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
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

/** The runtime's one-line JSON logs whose `msg` is `msg`. */
function logLines(runtime, msg) {
  return runtime
    .logs()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.msg === msg);
}

/** The lines of these calls that aren't between their call's START and END, from the `output` fixture. */
function outsideTheirCall(output, calls) {
  const outside = [];
  for (const { id, lines = 20, errors = 1, open = true } of calls) {
    const start = output.indexOf(`START RequestId: ${id} `);
    const end = output.indexOf(`END RequestId: ${id}\n`);
    const own = [
      ...Array.from({ length: lines }, (_, i) => `${id}: line ${i + 1}\n`),
      ...Array.from({ length: errors }, (_, i) => `${id}: error ${i + 1}\n`),
      ...(open ? [`${id}: left open`] : []),
    ];
    for (const text of own) {
      const at = output.indexOf(text);
      if (!(start >= 0 && start < at && at < end)) outside.push(text.trim());
    }
  }
  return outside;
}

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
    assert.equal(res.json.hasCallbackWaitsForEmptyEventLoop, false); // removed in Node.js 24, as on Lambda
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

  it('runs in the task root, so relative paths find the files next to the code', async () => {
    const rt = await startRuntime('cwd');
    await readyz(rt, 200);

    const res = await invoke(rt, {});

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { cwd: path.join(root, 'test/fixtures/cwd'), data: 'next to the code' });
    await rt.stop();
  });

  it('reports the peak memory, not what is left when the invocation ends, as Max Memory Used', async () => {
    const rt = await startRuntime('peak-memory', { FUNCTION_TIMEOUT: '10000' });
    await readyz(rt, 200);

    const res = await invoke(rt, { mb: 64 }, { 'x-ff-request-id': 'req-peak' });
    const reported = Number(res.headers.get('x-ff-max-memory-used-mb'));

    assert.equal(res.status, 200);
    // The 64 MB were freed before the invocation ended; the peak still counts them.
    assert.ok(reported >= res.json.rssMb + 48, `reported ${reported} MB, resident afterwards ${res.json.rssMb} MB`);
    assert.match(rt.logs(), new RegExp(`REPORT RequestId: req-peak\t.*Max Memory Used: ${reported} MB`));
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

  it('logs the error as the Python runtime does, with the stack trace of the TypeScript source, before END', async () => {
    const rt = await startRuntime('throws');
    await readyz(rt, 200);

    await invoke(rt, {}, { 'x-ff-request-id': 'req-err' });

    const [line] = logLines(rt, 'function error');
    assert.ok(line, `no "function error" line in:\n${rt.logs()}`);
    assert.deepEqual(
      { requestId: line.requestId, errorType: line.errorType, errorMessage: line.errorMessage, level: line.level },
      { requestId: 'req-err', errorType: 'TypeError', errorMessage: 'bad input', level: 'error' },
    );
    // Line 2 of function.ts: the source map is applied, and the runtime's own frames are left out.
    assert.match(line.stackTrace[0], /function\.ts:2:\d+/);
    assert.ok(line.stackTrace.every((frame) => !frame.includes('/dist/') && !frame.includes('node:internal')), line.stackTrace.join('\n'));
    assert.ok(rt.logs().indexOf('"function error"') < rt.logs().indexOf('END RequestId: req-err'));
    await rt.stop();
  });

  it('answers Runtime.MarshalError for a result JSON cannot hold, and keeps serving', async () => {
    const rt = await startRuntime('unmarshalable');
    await readyz(rt, 200);

    for (const [kind, reason] of [
      ['function', /a function has no JSON representation/],
      ['symbol', /a symbol has no JSON representation/],
      ['bigint', /BigInt/],
      ['circular', /circular/i],
    ]) {
      const res = await invoke(rt, { kind });
      assert.equal(res.status, 500, `${kind}: ${res.text}`);
      assert.equal(res.json.errorType, 'Runtime.MarshalError', kind);
      assert.match(res.json.errorMessage, /^Unable to marshal response: /);
      assert.match(res.json.errorMessage, reason);
    }
    const after = await invoke(rt, { kind: 'none' });

    assert.deepEqual([after.status, after.json], [200, 'ok']);
    assert.deepEqual(logLines(rt, 'function error'), []); // not the function's own error
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

    const res = await invoke(rt, {}, { 'x-ff-request-id': 'req-oom' });
    const ready = await readyz(rt, 200);

    assert.equal(res.status, 500);
    assert.equal(res.json.errorType, 'Runtime.OutOfMemory');
    assert.equal(ready.status, 200);
    assert.deepEqual(
      logLines(rt, 'function worker crashed; restarting').map(({ errorType, requestId }) => ({ errorType, requestId })),
      [{ errorType: 'Runtime.OutOfMemory', requestId: 'req-oom' }],
    );
    await rt.stop();
  });

  it('budgets the function memory minus what the runtime uses', async () => {
    const rt = await startRuntime('allocate', { FUNCTION_MEMORY_LIMIT: '256', FUNCTION_TIMEOUT: '10000' });
    await readyz(rt, 200);

    const fits = await invoke(rt, { mb: 100 });
    const tooBig = await invoke(rt, { mb: 230 }); // 256 MB minus the runtime's ~45 MB, a worker's 12 MB and a 16 MB margin is less
    await readyz(rt, 200);
    const after = await invoke(rt, { mb: 50 });

    assert.deepEqual([fits.status, fits.json], [200, 100]);
    assert.equal(tooBig.status, 500);
    assert.equal(tooBig.json.errorType, 'Runtime.OutOfMemory');
    assert.deepEqual([after.status, after.json], [200, 50]);
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
    // The TypeScript transpiler would recover from this and run `return {}`.
    ['ts-syntax-error', 'Runtime.UserCodeSyntaxError', /function\.ts:3:\d+ Property assignment expected/],
    ['no-handler', 'Runtime.HandlerNotFound', /function\.handler is undefined/],
    ['empty', 'Runtime.ImportModuleError', /Cannot find module 'function'/],
    ['callback', 'Runtime.CallbackHandlerDeprecated', /function\.handler declares a third parameter, a callback.*async \(event, context\)/],
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
      // A first load that fails is the code's fault: the runtime stays up and reports it.
      assert.equal(await rt.exitCode(300), 'running');
      await rt.stop();
    });
  }

  it('exits, so the container restarts, when a replacement worker cannot load code that loaded before', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-rt-')), 'loaded');
    const rt = await startRuntime('reload-fails', { FF_TEST_MARKER: marker });
    await readyz(rt, 200);

    const crashed = await invoke(rt, { crash: true });
    const code = await rt.exitCode(5000);

    assert.equal(crashed.status, 500);
    assert.equal(crashed.json.errorType, 'Runtime.ExitError');
    assert.equal(code, 1);
    assert.deepEqual(
      logLines(rt, 'function reload failed; exiting so the container restarts').map((l) => l.errorMessage),
      ['Error: reload fails'],
    );
    fs.rmSync(path.dirname(marker), { recursive: true, force: true });
  });

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

  it('answers 429 to a call that waited longer than FF_MAX_QUEUE_WAIT_MS for the instance', async () => {
    const rt = await startRuntime('slow-echo', { FF_MAX_QUEUE_WAIT_MS: '100' }); // each call takes 200 ms
    await readyz(rt, 200);

    const results = await Promise.all([invoke(rt, { n: 1 }), invoke(rt, { n: 2 })]);

    assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
    assert.deepEqual(results.find((r) => r.status === 429).json, {
      errorType: 'TooManyRequestsException',
      errorMessage: 'Rate exceeded: no instance was free within 0.10 seconds',
    });
    await rt.stop();
  });

  it('lets a call wait at most one function timeout by default', async () => {
    const rt = await startRuntime('slow-echo', { FUNCTION_TIMEOUT: '300' }); // each call takes 200 ms
    await readyz(rt, 200);

    // The second call waits about 200 ms, the third about 400 ms: more than the 300 ms timeout.
    const results = await Promise.all([invoke(rt, { n: 1 }), invoke(rt, { n: 2 }), invoke(rt, { n: 3 })]);

    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 429]);
    await rt.stop();
  });

  it('answers unknown routes with 404', async () => {
    const rt = await startRuntime('js-function');

    const res = await fetch(`${rt.base}/nope`);

    assert.equal(res.status, 404);
    await rt.stop();
  });
});

describe("logs: a call's output comes before its END", () => {
  // The collector tags each line with the call between its pod's START and REPORT lines (ADR 0005), so a
  // line that came after END would go untagged. The worker's output reaches this process through the main
  // thread, which prints END once the worker has marked the end of the call's output on both streams.
  it('writes every line of a call before its END, on stdout and stderr, and never the end-of-call markers', async () => {
    const rt = await startRuntime('output', { FUNCTION_TIMEOUT: '5000' }, { oneFile: true });
    await readyz(rt, 200);

    // Calls that write mostly to stdout, and calls that write only to stderr: END waits for both streams.
    const calls = Array.from({ length: 20 }, (_, i) =>
      i % 2 ? { id: `req-order-${i + 1}`, lines: 0, errors: 20, open: false } : { id: `req-order-${i + 1}`, lines: 20, errors: 1 },
    );
    for (const { id, ...body } of calls) assert.equal((await invoke(rt, body, { 'x-ff-request-id': id })).status, 200);

    const output = rt.logs();
    assert.ok(!output.includes('ff-end-of-call'), 'an end-of-call marker reached the output');
    assert.deepEqual(outsideTheirCall(output, calls), [], `lines outside their call's START and END:\n${output}`);
    await rt.stop();
  });

  it('starts its own lines on a line of their own when the call left one open, and adds no empty line otherwise', async () => {
    const rt = await startRuntime('output', { FUNCTION_TIMEOUT: '5000' });
    await readyz(rt, 200);

    await invoke(rt, { lines: 1 }, { 'x-ff-request-id': 'req-open' });
    await invoke(rt, { lines: 1, open: false }, { 'x-ff-request-id': 'req-closed' });

    const stdout = rt.stdout();
    assert.match(stdout, /\nreq-open: line 1\nreq-open: left open\nEND RequestId: req-open\nREPORT RequestId: req-open\t/);
    assert.match(stdout, /\nSTART RequestId: req-closed Version: \$LATEST\nreq-closed: line 1\nEND RequestId: req-closed\nREPORT /);
    await rt.stop();
  });

  it('waits a second at most for output that work left running holds up, and leaves the wait out of the duration', async () => {
    const rt = await startRuntime('output', { FUNCTION_TIMEOUT: '5000' }, { oneFile: true });
    await readyz(rt, 200);

    // The handler returns, then blocks its worker for 3 s: the end of its output can't come before that.
    const started = Date.now();
    const blocked = await invoke(rt, { lines: 1, busyMs: 3000 }, { 'x-ff-request-id': 'req-blocked' });
    const elapsed = Date.now() - started;
    const next = { id: 'req-next', lines: 20, errors: 20, open: false };
    const { id: nextId, ...nextBody } = next;
    const answer = await invoke(rt, nextBody, { 'x-ff-request-id': nextId });

    assert.equal(blocked.status, 200);
    assert.ok(elapsed >= 1000 && elapsed < 2500, `answered after ${elapsed} ms`);
    assert.ok(Number(blocked.headers.get('x-ff-duration-ms')) < 500, `duration ${blocked.headers.get('x-ff-duration-ms')} ms`);
    // The blocked call's late output is kept, its markers taken out, and they don't end the next call early.
    assert.equal(answer.status, 200);
    const output = rt.logs();
    assert.ok(!output.includes('ff-end-of-call'), 'an end-of-call marker reached the output');
    assert.ok(output.includes('req-blocked: left open'), "the blocked call's late output was lost");
    assert.deepEqual(outsideTheirCall(output, [next]), [], `lines outside their call's START and END:\n${output}`);
    await rt.stop();
  });

  it("marks the end of a call's output even when the code replaced process.stdout.write", async () => {
    const rt = await startRuntime('prefixed-stdout', { FUNCTION_TIMEOUT: '5000' });
    await readyz(rt, 200);

    const started = Date.now();
    for (const id of ['req-prefixed-1', 'req-prefixed-2']) await invoke(rt, {}, { 'x-ff-request-id': id });
    const elapsed = Date.now() - started;

    // The markers don't go through the replacement, so they neither leave a prefix behind nor get lost.
    assert.match(rt.stdout(), /\[app\] req-prefixed-1: hello\nEND RequestId: req-prefixed-1\n/);
    assert.ok(!rt.stdout().includes('ff-end-of-call'), 'an end-of-call marker reached the output');
    assert.ok(elapsed < 1000, `two calls took ${elapsed} ms`);
    await rt.stop();
  });

  it('keeps the answer of a call whose handler returned when work it left running then fills the heap', async () => {
    const rt = await startRuntime('late-oom', { FUNCTION_TIMEOUT: '10000' });
    await readyz(rt, 200);

    const res = await invoke(rt, {}, { 'x-ff-request-id': 'req-late' });
    await readyz(rt, 200);
    const next = await invoke(rt, { hoard: false }, { 'x-ff-request-id': 'req-after-crash' });

    assert.deepEqual([res.status, res.json], [200, 'answered']);
    assert.deepEqual([next.status, next.json], [200, 'answered']);
    // The crash is the worker's, after the call: logged after its REPORT, with no request ID.
    const [crash] = logLines(rt, 'function worker crashed; restarting');
    assert.deepEqual([crash?.errorType, crash?.requestId], ['Runtime.OutOfMemory', undefined]);
    assert.ok(rt.logs().indexOf('REPORT RequestId: req-late') < rt.logs().indexOf('function worker crashed'));
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

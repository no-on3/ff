# ff-runtime-nodejs (runtime protocol v2)

The image that runs every Node.js function on FF. User code is mounted read-only at `/var/task`, which is also the working directory. Nothing is installed when a function starts: the image already contains the compiled runtime and TypeScript (used to transpile `.ts` files).

| | |
|---|---|
| Image | `ff-runtime-nodejs:24-v2` (`24` = Node.js 24 LTS, as in Lambda's `nodejs24.x`; `v2` = runtime protocol, see [What changed in v2](#what-changed-in-v2)) |
| Base | `node:24-alpine`. First built 2026-10-16 from `sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f` (Node v24.22.0); `24-v2` was built on 2026-10-17 on the same base. The tag is deliberately not pinned to a digest, so rebuilds pick up security patches; rebuild regularly. |
| Size | about 195 MB |
| User | `10001:10001` (numeric, so Kubernetes `runAsNonRoot` can verify it) |
| Dependency | `typescript` 5.7.3, and nothing else (no Express, no ts-node) |

## How it works

```
main thread (main.ts)                        worker thread (worker.ts)
 HTTP :8080  /healthz /readyz /invoke ──────▶ loads /var/task/function.(ts|js|cjs) once
 queue: one invocation at a time               runs handler(event, context)
 timer per invocation ── timeout/OOM/crash ──▶ terminate + start a fresh worker
```

User code never runs on the main thread. A CPU-bound infinite loop, a memory blow-up, or `process.exit()` only kills the worker: the main thread answers probes, reports a Lambda-style error, and starts a new worker. This fixes findings H-8 and H-9 of the review (environment dump, no timeout).

If that new worker can't load code that loaded before, the environment is broken, not the code (a reload that times out at 0.1 CPU, for example). The runtime then answers the waiting invocations with the error, logs `function reload failed; exiting so the container restarts`, and exits with status 1, so Kubernetes restarts the container. A failure of the very first load is the code's fault: it stays reported on `/readyz`.

## HTTP protocol

| Request | Response |
|---|---|
| `GET /healthz` | `200 {"status":"ok"}` while the main thread is alive (liveness probe) |
| `GET /readyz` | `200 {"status":"ready"}` once user code is loaded. Otherwise `503 {"status":"starting"}`, or `503 {"status":"failed","error":{errorType,errorMessage}}` (readiness probe) |
| `POST /invoke` | Body = JSON payload (empty means `{}`). Optional header `X-FF-Request-Id`. Returns `200` with the handler's return value as JSON (`null` for `undefined`). |

**Response headers:** `X-FF-Request-Id`, `X-FF-Duration-Ms`, `X-FF-Max-Memory-Used-Mb`, and `X-FF-Function-Error: Unhandled` on function errors.

**Error responses** (body `{"errorType","errorMessage"}`):

| Status | `errorType` | When |
|---|---|---|
| 500 | The thrown error's name (e.g. `TypeError`) | The handler threw or rejected |
| 504 | `Sandbox.Timedout` | `Task timed out after X.XX seconds`; the worker is recycled |
| 500 | `Runtime.OutOfMemory` | The worker's heap limit was exceeded (see [Memory](#memory)); recycled |
| 500 | `Runtime.ExitError` | User code exited or crashed the worker; recycled |
| 500 | `Runtime.MarshalError` | The return value has no JSON form: a function, a symbol, a `BigInt`, or a cycle. `Unable to marshal response: …`, as the Python runtime says |
| 500 | `Function.ResponseSizeTooLarge` | Return value above 6 MB |
| 500 | `Runtime.ImportModuleError`, `Runtime.UserCodeSyntaxError`, `Runtime.HandlerNotFound`, `Runtime.MalformedHandlerName`, `Runtime.CallbackHandlerDeprecated`, `Sandbox.Timedout` (init) | User code can't be loaded; `/readyz` stays 503, so Kubernetes never routes to the pod |
| 400 | `InvalidRequestContentException` | Body is not JSON |
| 413 | `RequestEntityTooLargeException` | Body above 6 MB |
| 429 | `TooManyRequestsException` | More than `FF_MAX_QUEUE` invocations waiting, or one waited longer than `FF_MAX_QUEUE_WAIT_MS` for its turn: `Rate exceeded: no instance was free within X.XX seconds` |

The error names follow AWS Lambda's, so code and tooling port across.

## Handler contract

```ts
export async function handler(event, context) { … }
// event:   { body, headers, method, query, path }        body = the invoke payload
// context: { functionName, functionVersion, memoryLimitInMB (string), awsRequestId,
//            getRemainingTimeInMillis() }
```

- `getRemainingTimeInMillis()` counts down from the start of *this* invocation, not from process start.
- **The working directory is the task root** (`/var/task`), as on Lambda, so relative paths such as `fs.readFileSync('config.json')` find the files next to the code.
- **No callback-based handlers,** as on Lambda's Node.js 24 runtime: a handler that declares a third parameter fails to load with `Runtime.CallbackHandlerDeprecated`. Return the result, or throw, from an async handler instead. AWS doesn't document whether an async handler with an unused third parameter is spared, so FF refuses that too: remove the parameter. `context.callbackWaitsForEmptyEventLoop` went with callbacks, as on Lambda.

`.ts` files are transpiled without type checking, so type errors don't stop a function. Syntax errors do: they fail initialization with `Runtime.UserCodeSyntaxError` and the position, for example `function.ts:2:11 Property assignment expected.`. The first version let the transpiler recover and run different code instead.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `LAMBDA_TASK_ROOT` | `/var/task` | Where the user code lives |
| `FF_HANDLER` | `function.handler` | `<file>.<export>`; subdirectories allowed (`src/app.handler`) |
| `FUNCTION_TIMEOUT` | `30000` | Invocation timeout in **ms** |
| `FUNCTION_MEMORY_LIMIT` | `128` | MB; sizes the worker heap limit and sets `context.memoryLimitInMB` |
| `FUNCTION_NAME`, `FUNCTION_VERSION` | `unknown`, `$LATEST` | Reported in `context` and the logs |
| `FF_INIT_TIMEOUT_MS` | `max(10000, FUNCTION_TIMEOUT)` | Limit for loading user code |
| `FF_MAX_QUEUE` | `32` | Invocations allowed to wait behind the running one |
| `FF_MAX_QUEUE_WAIT_MS` | `FUNCTION_TIMEOUT` | How long an invocation may wait for its turn before it gets 429. The backend's own timeout covers this wait plus the run, so it never gives up on a call that is only waiting |
| `PORT` | `8080` | HTTP port |

## Memory

On Kubernetes the container's memory limit equals the function's memory, as on Lambda. A container that reaches it is killed by the kernel, and repeated kills put the pod into CrashLoopBackOff. A full V8 heap only ends the worker. So the worker's heap limit is the function's memory (or the container limit, if lower), minus 35 MB for the main thread (or more, if the container already uses more at start), 12 MB for a worker's baseline, and 16 MB of margin. A 128 MB function gets about 65 MB of heap; the startup log line shows it (`heapLimitMb`). The first version allowed 80% of the function's memory, and on the cluster the container was OOM-killed first.

Verified on k3d through the API server proxy, with a 128 MB function: a heap-hoarding handler got `Runtime.OutOfMemory` 5 times out of 5, the next invocation always succeeded, and the container restarted 0 times.

Not covered: V8 checks its limit when it collects garbage, so a single huge allocation can get past it, and `Buffer`s live outside the heap. Either can still reach the container limit and restart the container.

At 0.1 CPU, V8's last collections before it gives up can take several seconds, so a function that fills its heap slowly may hit its timeout first and get `Sandbox.Timedout` instead. The L3 test gives its memory hog 30 s for that reason.

## Logs

The user's `console.*` output goes to stdout unchanged. Each invocation adds Lambda-format lines:

```
START RequestId: <id> Version: $LATEST
END RequestId: <id>
REPORT RequestId: <id>	Duration: 12.34 ms	Billed Duration: 13 ms	Memory Size: 128 MB	Max Memory Used: 61 MB
```

`Max Memory Used`, and the `X-FF-Max-Memory-Used-Mb` header, are the runtime's peak resident memory since it started, all threads together, as Lambda reports it. Version 1 reported the memory in use when the call ended, which understated what a call needed.

An error thrown by the handler is also logged, before `END`, as one JSON line, the same as the Python runtime writes:

```json
{"time":"…","level":"error","msg":"function error","requestId":"…","errorType":"TypeError","errorMessage":"bad input","stackTrace":["at handler (/var/task/function.ts:2:9)"]}
```

The stack trace points at the lines of the TypeScript source (source maps are on), and leaves out the runtime's own frames and Node's internals. Platform events (start, initialization, timeouts, restarts) are one-line JSON too. **Environment variables are never logged.**

## What changed in v2

Protocol v2 (2026-10-17, client-readiness plan P-04) keeps v1's HTTP interface, so the backend works with both. A function moves to v2 at its next update. What changed:

| | v1 | v2 |
|---|---|---|
| Working directory | `/opt/ff` | `/var/task`, as on Lambda |
| `Max Memory Used` | in use when the call ended | the peak, as on Lambda and the Python runtime |
| Handler errors in the logs | not logged | a `function error` JSON line with the source-mapped stack trace |
| A result JSON can't hold | `undefined` body, which could crash the main thread | `Runtime.MarshalError` |
| Callback handlers | loaded, then failed with `TypeError` | refused at load: `Runtime.CallbackHandlerDeprecated` |
| A reload that fails after a crash | pod unready for good | the runtime exits, and Kubernetes restarts it |
| A call waiting for its turn | waited as long as the queue took | waits at most `FF_MAX_QUEUE_WAIT_MS`, one timeout by default, then gets 429 |

## Developing and testing

```bash
cd runtimes/nodejs
npm install
npm test                       # L1: 31 protocol tests on real processes, ~10 s, no Docker
test/container-smoke.sh        # L2: builds the image and runs it hardened (read-only, uid 10001, no capabilities)
```

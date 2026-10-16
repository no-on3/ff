# ff-runtime-nodejs (runtime protocol v1)

The image that runs every Node.js function on FF. User code is mounted read-only at `/var/task`. Nothing is installed when a function starts: the image already contains the compiled runtime and TypeScript (used to transpile `.ts` files).

| | |
|---|---|
| Image | `ff-runtime-nodejs:24-v1` (`24` = Node.js 24 LTS, as in Lambda's `nodejs24.x`; `v1` = runtime protocol) |
| Base | `node:24-alpine`. Built 2026-10-16 from `sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f` (Node v24.22.0). The tag is deliberately not pinned to a digest, so rebuilds pick up security patches; rebuild regularly. |
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
| 500 | `Function.ResponseSizeTooLarge` | Return value above 6 MB |
| 500 | `Runtime.ImportModuleError`, `Runtime.UserCodeSyntaxError`, `Runtime.HandlerNotFound`, `Runtime.MalformedHandlerName`, `Sandbox.Timedout` (init) | User code can't be loaded; `/readyz` stays 503, so Kubernetes never routes to the pod |
| 400 | `InvalidRequestContentException` | Body is not JSON |
| 413 | `RequestEntityTooLargeException` | Body above 6 MB |
| 429 | `TooManyRequestsException` | More than `FF_MAX_QUEUE` invocations waiting |

The error names follow AWS Lambda's, so code and tooling port across.

## Handler contract (unchanged from the original FF wrapper)

```ts
export async function handler(event, context) { … }
// event:   { body, headers, method, query, path }        body = the invoke payload
// context: { functionName, functionVersion, memoryLimitInMB (string), awsRequestId,
//            getRemainingTimeInMillis(), callbackWaitsForEmptyEventLoop }
```

`getRemainingTimeInMillis()` counts down from the start of *this* invocation, not from process start.

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
| `PORT` | `8080` | HTTP port |

## Memory

On Kubernetes the container's memory limit equals the function's memory, as on Lambda. A container that reaches it is killed by the kernel, and repeated kills put the pod into CrashLoopBackOff. A full V8 heap only ends the worker. So the worker's heap limit is the function's memory (or the container limit, if lower), minus 35 MB for the main thread (or more, if the container already uses more at start), 12 MB for a worker's baseline, and 16 MB of margin. A 128 MB function gets about 65 MB of heap; the startup log line shows it (`heapLimitMb`). The first version allowed 80% of the function's memory, and on the cluster the container was OOM-killed first.

Verified on k3d through the API server proxy, with a 128 MB function: a heap-hoarding handler got `Runtime.OutOfMemory` 5 times out of 5, the next invocation always succeeded, and the container restarted 0 times.

Not covered: V8 checks its limit when it collects garbage, so a single huge allocation can get past it, and `Buffer`s live outside the heap. Either can still reach the container limit and restart the container.

## Logs

The user's `console.*` output goes to stdout unchanged. Each invocation adds Lambda-format lines:

```
START RequestId: <id> Version: $LATEST
END RequestId: <id>
REPORT RequestId: <id>	Duration: 12.34 ms	Billed Duration: 13 ms	Memory Size: 128 MB	Max Memory Used: 61 MB
```

Platform events (start, initialization, timeouts, restarts) are one-line JSON. **Environment variables are never logged.**

## Developing and testing

```bash
cd runtimes/nodejs
npm install
npm test                       # L1: 22 protocol tests on real processes, ~10 s, no Docker
test/container-smoke.sh        # L2: builds the image and runs it hardened (read-only, uid 10001, no capabilities)
```

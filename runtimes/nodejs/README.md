# ff-runtime-nodejs (runtime protocol v3)

The image that runs every Node.js function on FF. User code is mounted read-only at `/var/task`, which is also the working directory. Nothing is installed when a function starts: the image already contains the compiled runtime, TypeScript (used to transpile `.ts` files), and a code cache of TypeScript (see "Start-up").

| | |
|---|---|
| Image | `ff-runtime-nodejs:24-v3` (`24` = Node.js 24 LTS, as in Lambda's `nodejs24.x`; `v3` = runtime protocol, see [What changed in v3](#what-changed-in-v3)) |
| Base | `node:24-trixie-slim`: Debian 13, glibc 2.41, as the Python runtime's, since 2026-10-21, built from `sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c` (Node v24.22.0). Before, `node:24-alpine` (musl): first built 2026-10-16 from `sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f`, `24-v2` on 2026-10-17 and last rebuilt on 2026-10-20 (the TypeScript code cache, npm removed), `24-v3` on 2026-10-21, rebuilt the same day for AWS Lambda's handler resolution (below). The tag is deliberately not pinned to a digest, so rebuilds pick up security patches; rebuild regularly. |
| Why glibc | A native module built for Linux as AWS Lambda builds them, against glibc, loads: bcrypt 5.1.1's prebuilt `linux-x64-glibc` binary, as npm installs it on a glibc machine, hashes here; on Alpine's musl the same package loaded, then crashed the process (SIGSEGV) at its first hash. Not `node:24-slim`, which is still Debian 12's glibc 2.36: 2.41 runs what a newer glibc built, and matches the Python runtime. Trivy finds no fixed high or critical vulnerability in it (2026-10-21) |
| Size | about 260 MB, with the code cache of TypeScript (198 MB on Alpine). npm, npx, corepack and yarn are removed: nothing runs them, and npm's own dependencies had advisories |
| User | `10001:10001` (numeric, so Kubernetes `runAsNonRoot` can verify it) |
| Dependency | `typescript` 5.7.3, and nothing else (no Express, no ts-node) |

## How it works

```
main thread (main.ts)                        worker thread (worker.ts)
 HTTP :8080  /healthz /readyz /invoke ──────▶ loads the handler's file once (.js .mjs .cjs .ts)
 queue: one invocation at a time               runs handler(event, context)
 timer per invocation ── timeout/OOM/crash ──▶ terminate + start a fresh worker
 forwards output (relay.ts); END last ◀────── stdout, stderr; marks each call's end
```

User code never runs on the main thread. A CPU-bound infinite loop, a memory blow-up, or `process.exit()` only kills the worker: the main thread answers probes, reports a Lambda-style error, and starts a new worker. This fixes findings H-8 and H-9 of the review (environment dump, no timeout).

If that new worker can't load code that loaded before, the environment is broken, not the code (a reload that times out at 0.1 CPU, for example). The runtime then answers the waiting invocations with the error, logs `function reload failed; exiting so the container restarts`, and exits with status 1, so Kubernetes restarts the container. A failure of the very first load is the code's fault: it stays reported on `/readyz`.

### Start-up

Loading the code must fit in the start-up limit, 10 s (or the function's timeout if longer), as on Lambda. At the smallest size, 128 MB, a pod gets 0.1 CPU, and in gVisor every step is slower. The longest step was TypeScript: compiling the compiler, about 9 MB of JavaScript, then the functions its first transpile runs, took 7 to 10 s of the limit (client-readiness plan, P-62).

- **The image keeps a V8 code cache of TypeScript** (`/opt/ff/typescript.codecache`, `src/typescript-cache.ts`), written at the build after a transpile, so that it holds the transpile's code too. The worker loads TypeScript with it. In gVisor at 0.1 CPU that takes 2.0 to 2.2 s, and the first transpile 0.2 to 0.4 s; a 128 MB function's code now loads in 2 to 5 s.
- **Only a `.ts` handler loads TypeScript.** A `.js`, `.mjs` or `.cjs` one never does.
- **The cache only speeds things up.** Without it, or if V8 refuses it (made by another Node.js version), TypeScript is compiled as before, only slower. `test/container-smoke.sh` checks that the image's cache is taken in a worker thread.
- `hack/k8s/cold-start-benchmark.sh` measures it on the dev cluster, any size and RuntimeClass, several functions at once.
- **On the glibc base** (2026-10-21), 128 MB in gVisor, three at once, two rounds: the code loaded 1.4 to 2.3 s after the runtime listened, and each function was ready 5.1 to 8.0 s after its deploy.

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
// event:   the payload of POST /invoke itself, any JSON value, as on AWS Lambda; or, with
//          FF_EVENT_FORMAT=wrapped, { body, headers, method, query, path } with body = the payload
// context: { functionName, functionVersion, memoryLimitInMB (string), awsRequestId,
//            getRemainingTimeInMillis() }
```

- **The event is the payload,** as on Lambda: `POST /invoke` with `{"name": "Tunis"}` calls the handler with `event.name === 'Tunis'`. FF's backend builds every event a function gets: an invoke's input, a function URL's HTTP event, a schedule's ([ADR 0007](../../docs/adr/0007-function-events.md)). A function made before protocol 3 keeps FF's original wrapper, which the runtime builds from its own request when `FF_EVENT_FORMAT=wrapped`.

- `getRemainingTimeInMillis()` counts down from the start of *this* invocation, not from process start.
- **The working directory is the task root** (`/var/task`), as on Lambda, so relative paths such as `fs.readFileSync('config.json')` find the files next to the code.
- **No callback-based handlers,** as on Lambda's Node.js 24 runtime: a handler that declares a third parameter fails to load with `Runtime.CallbackHandlerDeprecated`. Return the result, or throw, from an async handler instead. AWS doesn't document whether an async handler with an unused third parameter is spared, so FF refuses that too: remove the parameter. `context.callbackWaitsForEmptyEventLoop` went with callbacks, as on Lambda.

`.ts` files are transpiled without type checking, so type errors don't stop a function. Syntax errors do: they fail initialization with `Runtime.UserCodeSyntaxError` and the position, for example `function.ts:2:11 Property assignment expected.`. The first version let the transpiler recover and run different code instead.

### Finding the handler

`FF_HANDLER` names it as AWS Lambda's does, and the runtime finds it as Lambda's Node.js runtime does, so a package made for Lambda runs unchanged:
- **`[<folders>/]<file>.<export>`:** the file's name runs to the first dot after the last slash, and what follows is a path through its exports. `src/api.handlers.get` is `handlers.get` of `src/api.js`, and `index.default` is an ES module's default export.
- **The file:** the name itself, then `.js`, `.mjs`, `.cjs`, as Lambda looks for them, and `.ts` last, which Lambda doesn't know: next to `app.ts`, `app.js` is the one loaded. Inline code is `function.ts`.
- **ES modules are imported:** a `.mjs` file, and a `.js` file whose nearest `package.json` says `"type": "module"`, as Lambda reads it. Their top-level `await` runs once, before the first call. The rest is required, as CommonJS.
- **Refused:** a handler without a dot in its last part, or with `..` anywhere, as Lambda refuses it (`Runtime.MalformedHandlerName`); a file that isn't there (`Runtime.ImportModuleError`, naming the extensions tried); an export that is missing (`… is undefined or not exported`) or isn't a function (`… is not a function`), both `Runtime.HandlerNotFound`.
- **Not taken from Lambda:** its last resort, a package of `node_modules` named alone (`some-package.handler`); and a handler outside the package, such as an absolute path into a layer, which FF's API refuses: FF has no layers.

### Packages

A function made from a package, a zip as AWS Lambda takes one (`ff deploy <folder>`, or the API's `codeSha256`), has its files at `/var/task`, read-only: an image of them that its pod mounts on this image, as inline code has its one `function.ts` there, from an image of its own ([ADR 0003](../../docs/adr/0003-code-delivery.md)).
- **The handler's file** is at the root or in folders, as `FF_HANDLER` names it: `index.handler` is `index.js`, `src/handlers/orders.create` is `src/handlers/orders.js` (or `.mjs`, `.cjs`, `.ts`), loaded as above.
- **`node_modules/` at the root:** `require` and `import` look for a library from the importing file's folder upward, as Node.js does, so `/var/task/node_modules` serves every file of the package.
- **Native modules** load when built for Linux x86_64 and glibc 2.41 or older, as npm installs prebuilt `linux-x64-glibc` binaries: bcrypt's hashes here (`hack/cli-e2e.sh` checks it). One built for musl, or another system, doesn't load.
- **Read-only:** a function writes to `/tmp`, 512 MiB, as on Lambda.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `LAMBDA_TASK_ROOT` | `/var/task` | Where the user code lives |
| `FF_HANDLER` | `function.handler` | `<file>.<export>`, as AWS Lambda's handler: see [Finding the handler](#finding-the-handler) |
| `FUNCTION_TIMEOUT` | `30000` | Invocation timeout in **ms** |
| `FUNCTION_MEMORY_LIMIT` | `128` | MB; sizes the worker heap limit and sets `context.memoryLimitInMB` |
| `FUNCTION_NAME`, `FUNCTION_VERSION` | `unknown`, `$LATEST` | Reported in `context` and the logs |
| `FF_INIT_TIMEOUT_MS` | `max(10000, FUNCTION_TIMEOUT)` | Limit for loading user code |
| `FF_MAX_QUEUE` | `32` | Invocations allowed to wait behind the running one |
| `FF_MAX_QUEUE_WAIT_MS` | `FUNCTION_TIMEOUT` | How long an invocation may wait for its turn before it gets 429. The backend's own timeout covers this wait plus the run, so it never gives up on a call that is only waiting |
| `PORT` | `8080` | HTTP port |
| `FF_EVENT_FORMAT` | `lambda` | `lambda`: the payload is the event; `wrapped`: FF's original wrapper around it. Anything else stops the runtime at start, with `unknown FF_EVENT_FORMAT` |

### Buckets, with AWS's SDK

A function's pods get a key to its account's buckets in their environment, as AWS Lambda gives a function its role's credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and `AWS_DEFAULT_REGION`, and `AWS_ENDPOINT_URL_S3`, FF's S3 endpoint inside the cluster, an IP address. AWS's SDK for JavaScript v3 reads all of them, so `new S3Client({})` reaches the account's buckets as it is, path-style, as the SDK addresses an IP address by itself ([ADR 0009](../../docs/adr/0009-buckets.md)). The key is the function's own, made at its first deploy (an older function gets its own the next time an update rolls it out) and revoked when it is deleted; it reaches every bucket of the account, read-write, and its requests are checked as any key's. FF sets these names: a function's own variables can't.

The SDK isn't in the image, as it is in Lambda's Node.js runtimes: name `@aws-sdk/client-s3` in the package's `dependencies`, which `ff deploy <folder>` installs, as AWS recommends for Lambda too.

## Memory

On Kubernetes the container's memory limit equals the function's memory, as on Lambda. A container that reaches it is killed by the kernel, and repeated kills put the pod into CrashLoopBackOff. A full V8 heap only ends the worker. So the worker's heap limit is the function's memory (or the container limit, if lower), minus 35 MB for the main thread (or more, if the container already uses more at start), 12 MB for a worker's baseline, and 16 MB of margin. A 128 MB function gets about 65 MB of heap; the startup log line shows it (`heapLimitMb`). The first version allowed 80% of the function's memory, and on the cluster the container was OOM-killed first.

Verified on k3d through the API server proxy, with a 128 MB function: a heap-hoarding handler got `Runtime.OutOfMemory` 5 times out of 5, the next invocation always succeeded, and the container restarted 0 times.

Not covered: V8 checks its limit when it collects garbage, so a single huge allocation can get past it, and `Buffer`s live outside the heap. Either can still reach the container limit and restart the container.

At 0.1 CPU, V8's last collections before it gives up can take several seconds, so a function that fills its heap slowly may hit its timeout first and get `Sandbox.Timedout` instead. The L3 test gives its memory hog 30 s for that reason.

## Logs

The user's `console.*` output goes to stdout, or stderr for `console.error` and `console.warn`, unchanged. Each invocation adds Lambda-format lines:

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

The stack trace points at the lines of the TypeScript source (source maps are on), and leaves out the runtime's own frames and Node's internals. Platform events (start, initialization, timeouts, restarts) are one-line JSON too. A call's own events, a timeout (`task timed out; restarting worker`) or a crash, come before its `END`, as in the Python runtime, so the logs give them its request ID. **Environment variables are never logged.**

**A call's output comes before its `END`.** The log collector gives each line the request ID of the call between its pod's `START` and `REPORT` lines ([ADR 0005](../../docs/adr/0005-log-pipeline.md)), and so does `GET /functions/:id/logs`, so a line written after `END` would have none. A worker thread's output reaches the process asynchronously, so the main thread forwards it itself:
- **The end of a call's output is marked.** When the handler settles, the worker writes an end-of-call marker to its stdout and to its stderr, through the streams' own `write`, so code that replaced `process.stdout.write` changes nothing. The main thread takes the markers out of what it forwards. It writes `END` and `REPORT` once both markers have come, and only then answers the call and starts the next one.
- **It waits a second at most.** Work the handler left running can block the worker after the call, and hold the markers up. The call then ends after a second, and the rest of its output comes after its `END`. `Duration` stops when the handler settles, so the wait is never billed, and the backend's deadline leaves 2 s for it past the queue wait and the timeout.
- **Lines written after the handler settles,** by a timer or a promise it left running, come after `END`, as on Lambda. They have no request ID, or the next call's.
- **A line left open,** by `process.stdout.write` without a newline, is ended before the runtime's next line, so that `START`, `END`, `REPORT` and the JSON lines always start a line.
- **A worker that dies after its handler returned,** because work left running filled the heap or exited, doesn't fail that call: it keeps its answer, and the crash is logged after its `REPORT`, without a request ID. The next call gets a fresh worker.

The Python runtime needs none of this: its worker is a process that writes to the same stdout and stderr, unbuffered (`PYTHONUNBUFFERED`), before it sends its result.

## What changed in v3

Protocol v3 (2026-10-21, step-1 plan U-03, [ADR 0007](../../docs/adr/0007-function-events.md)) changes the event, and nothing else: the probes, the `X-FF-*` headers, the errors and the logs are v2's.

| | v2 | v3 |
|---|---|---|
| The event | `{ body, headers, method, query, path }`, built from the backend's request to the pod, `body` the payload | the payload itself, any JSON value, as on Lambda; the wrapper only with `FF_EVENT_FORMAT=wrapped` |
| The startup line | `"protocol": 2` | `"protocol": 3`, with `"eventFormat"` |

The backend tells each function's pods which format they get. Every function made before v3 is `wrapped`, and gets from v3 the same event as from v2.

## What changed in v2

Protocol v2 (2026-10-17, client-readiness plan P-04; the order of the logs, P-42) keeps v1's HTTP interface, so the backend works with both. A function moves to v2 at its next update. What changed:

| | v1 | v2 |
|---|---|---|
| Working directory | `/opt/ff` | `/var/task`, as on Lambda |
| `Max Memory Used` | in use when the call ended | the peak, as on Lambda and the Python runtime |
| Handler errors in the logs | not logged | a `function error` JSON line with the source-mapped stack trace |
| A result JSON can't hold | `undefined` body, which could crash the main thread | `Runtime.MarshalError` |
| Callback handlers | loaded, then failed with `TypeError` | refused at load: `Runtime.CallbackHandlerDeprecated` |
| A reload that fails after a crash | pod unready for good | the runtime exits, and Kubernetes restarts it |
| A call waiting for its turn | waited as long as the queue took | waits at most `FF_MAX_QUEUE_WAIT_MS`, one timeout by default, then gets 429 |
| A call's output | could reach the log after its `END`: the worker's last `console.log` line did for every call measured in P-41 | before its `END`, which waits a second at most for it (see [Logs](#logs)) |
| A timeout's log line | after the call's `REPORT` | before its `END`, as in the Python runtime |

## Developing and testing

```bash
cd runtimes/nodejs
npm install
npm test                       # L1: 41 protocol tests on real processes, 4 for the output relay, 3 for the code cache, ~20 s, no Docker
test/container-smoke.sh        # L2: builds the image and runs it hardened (read-only, uid 10001, no capabilities)
```

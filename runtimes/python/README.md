# ff-runtime-python (runtime protocol v3)

The image that runs every Python function on FF. It speaks the same HTTP protocol as [ff-runtime-nodejs](../nodejs/README.md), so the backend treats both runtimes alike. User code is mounted read-only at `/var/task`. Nothing is installed when a function starts.

| | |
|---|---|
| Image | `ff-runtime-python:3.13-v3` (`3.13` = Python 3.13, as in Lambda's `python3.13`; `v3` = runtime protocol, see [What changed in v3](#what-changed-in-v3)) |
| Base | `python:3.13-slim` (Debian, glibc 2.41). First built 2026-10-16 from `sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f` (Python 3.13.16); `3.13-v2` was built on 2026-10-17, and last rebuilt on 2026-10-20 (pip removed), still on Python 3.13.16; `3.13-v3` on 2026-10-21, on the same base, and rebuilt the same day to refuse a built-in module as the handler's, as Lambda does. The tag is deliberately not pinned to a digest, so rebuilds pick up security patches; rebuild regularly. |
| Size | about 122 MB. pip is removed: functions ship their dependencies, nothing can be installed on a read-only root, and the packages pip vendors had advisories |
| User | `10001:10001` (numeric, so Kubernetes `runAsNonRoot` can verify it) |
| Dependencies | None: the runtime uses only the standard library |
| Footprint | About 22 MB resident for the main process and 15 MB for an idle worker |

glibc rather than Alpine's musl, so `manylinux` wheels built for AWS Lambda also work here.

## How it works

```
main process (main.py)                        worker process (worker.py)
 HTTP :8080  /healthz /readyz /invoke ──────▶ imports the handler's module once
 one invocation at a time (lock + queue)        runs handler(event, context)
 deadline per invocation ── timeout/OOM/exit ─▶ kill + start a fresh worker
```

User code never runs in the main process. A Python thread cannot be stopped from outside, so the worker is a separate process: `python -P -m ff_runtime.worker`, connected to the main process by a socket pair that carries length-prefixed JSON messages (`protocol.py`). A CPU-bound infinite loop, a memory blow-up, or `sys.exit()` only ends the worker. The main process answers probes, reports a Lambda-style error, and starts a new worker. Starting a worker takes about 80 ms plus the import time of the user's module.

If a replacement worker can't load code that loaded before, the environment is broken, not the code (a reload that times out at 0.1 CPU, for example). The runtime then answers the waiting invocations with the error, logs `function reload failed; exiting so the container restarts`, and exits with status 1, so Kubernetes restarts the container. A failure of the very first load is the code's fault: it stays reported on `/readyz`.

Each connection gets its own thread, started with the low-level `_thread` call. `threading.Thread.start()` waits, with no timeout, for the new thread to report that it is running, so a thread that dies first under memory pressure would freeze the accept loop. That was seen under gVisor. If the runtime cannot start the worker or a thread it needs, it exits, and Kubernetes restarts the container.

`multiprocessing` is not used: its spawn mode starts an extra resource-tracker process in every container and re-imports the main module in the child. A plain subprocess avoids both and exposes the worker's exit status directly.

## HTTP protocol

| Request | Response |
|---|---|
| `GET /healthz` | `200 {"status": "ok"}` while the main process is alive (liveness probe) |
| `GET /readyz` | `200 {"status": "ready"}` once user code is loaded. Otherwise `503 {"status": "starting"}`, or `503 {"status": "failed", "error": {"errorType": …, "errorMessage": …}}` (readiness probe) |
| `POST /invoke` | Body = JSON payload (empty means `{}`; `Content-Length` or chunked). Optional header `X-FF-Request-Id`. Returns `200` with the handler's return value as JSON (`null` for `None`). |

**Response headers:** `X-FF-Request-Id`, `X-FF-Duration-Ms`, `X-FF-Max-Memory-Used-Mb`, and `X-FF-Function-Error: Unhandled` on function errors.

**Error responses** (body `{"errorType": …, "errorMessage": …}`):

| Status | `errorType` | When |
|---|---|---|
| 500 | The exception's class name (e.g. `ValueError`) | The handler raised |
| 504 | `Sandbox.Timedout` | `Task timed out after X.XX seconds`; the worker is recycled |
| 500 | `Runtime.OutOfMemory` | The worker exceeded its memory limit (see [Memory](#memory)); recycled |
| 500 | `Runtime.ExitError` | User code exited (`sys.exit`, `os._exit`) or crashed the worker: `Runtime exited with error: exit status 3`; recycled |
| 500 | `Runtime.MarshalError` | The return value is not JSON-serializable (a `set`, an object, `NaN`) |
| 500 | `Function.ResponseSizeTooLarge` | Return value above 6 MB |
| 500 | `Runtime.ImportModuleError`, `Runtime.UserCodeSyntaxError`, `Runtime.HandlerNotFound`, `Runtime.MalformedHandlerName`, `Runtime.BuiltInModuleConflict`, `Sandbox.Timedout` (init) | User code can't be loaded; `/readyz` stays 503, so Kubernetes never routes to the pod |
| 400 | `InvalidRequestContentException` | Body is not JSON |
| 413 | `RequestEntityTooLargeException` | Body above 6 MB |
| 429 | `TooManyRequestsException` | More than `FF_MAX_QUEUE` invocations waiting, or one waited longer than `FF_MAX_QUEUE_WAIT_MS` for its turn: `Rate exceeded: no instance was free within X.XX seconds` |

The error names and messages follow AWS Lambda's (for example `Unable to import module 'function': No module named 'requests'`), so code and tooling port across.

## Handler contract

AWS Lambda's signature:

```python
def handler(event, context):
    ...
# event:   the payload of POST /invoke itself, any JSON value, as on AWS Lambda; or, with
#          FF_EVENT_FORMAT=wrapped, {"body", "headers", "method", "query", "path"}, body = the payload
# context: function_name, function_version, invoked_function_arn (""),
#          memory_limit_in_mb (a string, as on Lambda), aws_request_id,
#          log_group_name (""), log_stream_name (""), identity (None),
#          client_context (None), get_remaining_time_in_millis()
```

- **The event is the payload,** as on Lambda: `POST /invoke` with `{"name": "Sfax"}` calls the handler with `event["name"] == "Sfax"`. FF's backend builds every event a function gets ([ADR 0007](../../docs/adr/0007-function-events.md)). A function made before protocol 3 keeps FF's original wrapper, which the runtime builds when `FF_EVENT_FORMAT=wrapped`.
- `get_remaining_time_in_millis()` counts down from the start of *this* invocation, not from process start.
- The working directory is the task root (`/var/task`), as on Lambda, so relative paths such as `open("config.json")` work.
- Module-level code runs once per worker, so clients created at import time (database pools, SDK clients) are reused across invocations.
- Return values are serialized with `json.dumps`. `decimal.Decimal` becomes a JSON number (boto3 returns DynamoDB numbers as `Decimal`), and non-ASCII text is sent as UTF-8.
- **Differences from Lambda.** `NaN` and `Infinity` are refused with `Runtime.MarshalError`; Lambda sends them, which is not valid JSON. `async def` handlers are not supported, the same as on Lambda: the coroutine is not JSON-serializable.
- **Code size.** Inline code is one `function.py` of up to 3 MiB, as AWS Lambda's console takes; a package, below, may have 250 MB unpacked.

### Packages

A function made from a package, a zip as AWS Lambda takes one (`ff deploy <folder>`, or the API's `codeSha256`), has its files at `/var/task`, read-only: an image of them that its pod mounts on this image, as inline code has its one `function.py` there, from an image of its own ([ADR 0003](../../docs/adr/0003-code-delivery.md)).
- **The handler's module** is a file at the root or in folders, as `FF_HANDLER` names it: `lambda_function.lambda_handler` is `lambda_function.py`, `app/handlers.create` and `app.handlers.create` are `app/handlers.py`, a folder with or without `__init__.py`.
- **Libraries at the root:** `/var/task` comes first on `sys.path`, so the packages `pip install -t` puts at the package's root import, before the image's own; `ff package` installs them so.
- **Compiled extensions** load when built for CPython 3.13 on Linux x86_64, glibc 2.41 or older (`*.cpython-313-x86_64-linux-gnu.so`): manylinux wheels, as Lambda's are; numpy's `manylinux_2_28` wheels import and compute (`hack/cli-e2e.sh` checks it).
- **Read-only:** a function writes to `/tmp`, 512 MiB, as on Lambda.

### Buckets, with boto3

A function's pods get a key to its account's buckets in their environment, as AWS Lambda gives a function its role's credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and `AWS_DEFAULT_REGION`, and `AWS_ENDPOINT_URL_S3`, FF's S3 endpoint inside the cluster, an IP address. boto3 reads all of them, so `boto3.client("s3")` reaches the account's buckets as it is, path-style, as boto3 addresses an IP address by itself ([ADR 0009](../../docs/adr/0009-buckets.md)). The key is the function's own, made at its first deploy (an older function gets its own the next time an update rolls it out) and revoked when it is deleted; it reaches every bucket of the account, read-write, and its requests are checked as any key's. FF sets these names: a function's own variables can't.

boto3 isn't in the image, as it is in Lambda's Python runtimes: name it in the package's `requirements.txt`, which `ff deploy <folder>` installs.

### Queues, with boto3

With the same key, the pods get `AWS_ENDPOINT_URL_SQS`, FF's SQS endpoint inside the cluster, so `boto3.client("sqs")` reaches the account's queues as it is ([ADR 0010](../../docs/adr/0010-queue.md)). boto3 sends every request to that endpoint, whatever the host of a queue's URL: a URL from outside (`https://sqs.<domain>/…`, as clients outside the cluster get it) works as it is, FF reading a queue's URL by its path.

## Memory

On Kubernetes the container's memory limit equals the function's memory, as on Lambda. A container that reaches it is killed by the kernel, all processes together (`memory.oom.group = 1`, verified on k3s v1.37.1), and repeated kills put the pod into CrashLoopBackOff. So the runtime stops the worker first:

- **Budget.** Once user code is loaded, the worker may use the function's memory (or the container limit, if lower), minus what the container already uses, minus 32 MB for the main process. The main process can hold a 6 MB request and reply more than once. The worker enforces this with `RLIMIT_DATA` = its current data size + the budget. Allocations beyond it raise `MemoryError`. The runtime reports `Runtime.OutOfMemory`, replaces the worker in about 0.1 to 1 s, and the container keeps running. Data the imports already reserved, such as numpy's buffers, is not charged twice.
- **Thread stacks.** `RLIMIT_DATA` also counts thread stacks, so Python threads get 2 MB stacks instead of 8 MB. Ten threads, the size of boto3's transfer pool, then take 20 MB of the budget rather than 80 MB.
- **Verified** on k3d through the API server proxy, with a 128 MB function: a hoarding handler got `Runtime.OutOfMemory` 5 times out of 5, the next invocation always succeeded, and the container restarted 0 times. With numpy 2.5.4 in a 128 MB container, 1000×1000 matrix products run and 2000×2000 gets `Runtime.OutOfMemory`; 2000×2000 runs in 256 MB.
- **What the budget misses** (memory that C extensions allocate in other ways, or a fork) still reaches the container limit. The worker's `oom_score_adj` of 1000 makes it the kernel's first choice of victim, but Kubernetes' group kill takes the whole container anyway.
- **Under gVisor** (K-11), `RLIMIT_DATA` is not enforced (verified), so the budget does not apply. A function that outgrows its memory meets the sandbox's limit instead.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `LAMBDA_TASK_ROOT` | `/var/task` | Where the user code lives; also the worker's working directory |
| `FF_HANDLER` | `function.handler` | `<module>.<function>`, as AWS Lambda's handler. Subdirectories are allowed: `src/app.handler` imports `src.app`. A module compiled into Python, such as `sys` or `time`, is refused with `Runtime.BuiltInModuleConflict`, as on Lambda: it would be imported instead of the function's |
| `FUNCTION_TIMEOUT` | `30000` | Invocation timeout in **ms** |
| `FUNCTION_MEMORY_LIMIT` | `128` | MB; sizes the worker's memory limit and sets `context.memory_limit_in_mb` |
| `FUNCTION_NAME`, `FUNCTION_VERSION` | `unknown`, `$LATEST` | Reported in `context` and the logs |
| `FF_INIT_TIMEOUT_MS` | `max(10000, FUNCTION_TIMEOUT)` | Limit for loading user code |
| `FF_MAX_QUEUE` | `32` | Invocations allowed to wait behind the running one |
| `FF_MAX_QUEUE_WAIT_MS` | `FUNCTION_TIMEOUT` | How long an invocation may wait for its turn before it gets 429. The backend's own timeout covers this wait plus the run, so it never gives up on a call that is only waiting |
| `PORT` | `8080` | HTTP port (all IPv6 and IPv4 addresses) |
| `FF_EVENT_FORMAT` | `lambda` | `lambda`: the payload is the event; `wrapped`: FF's original wrapper around it. Anything else stops the runtime at start, with `unknown FF_EVENT_FORMAT` |

The function's own environment variables reach user code unchanged.

`os.cpu_count()` reports the node's CPUs, not the function's CPU share (8 in a container limited to half a CPU). Libraries that size thread pools from it, such as numpy's OpenBLAS, then start more threads than the function can use. Set `OPENBLAS_NUM_THREADS` or `OMP_NUM_THREADS` in the function's environment.

## Logs

The user's `print` and `logging` output goes to stdout unchanged. Each invocation adds Lambda-format lines:

```
START RequestId: <id> Version: $LATEST
END RequestId: <id>
REPORT RequestId: <id>	Duration: 12.34 ms	Billed Duration: 13 ms	Memory Size: 128 MB	Max Memory Used: 38 MB
```

`Max Memory Used` is the peak resident memory of the main process plus the worker. Platform events (start, initialization, timeouts, restarts) are one-line JSON, written by `json.dumps`, so with a space after each `:` and `,`. An exception from the handler is also logged as one JSON line, the same as the Node.js runtime writes:

```json
{"time": "…", "level": "error", "msg": "function error", "requestId": "…", "errorType": "ValueError", "errorMessage": "…", "stackTrace": ["  File \"/var/task/function.py\", line 3, in handler\n    raise ValueError(\"…\")"]}
```

A worker replaced after `Runtime.OutOfMemory` is logged as `function worker crashed; restarting`, with the request ID, as on the Node.js runtime. **Environment variables are never logged.** On `SIGTERM` the runtime stops accepting connections, finishes the invocations in flight, and exits with status 0.

## What changed in v3

Protocol v3 (2026-10-21, step-1 plan U-03, [ADR 0007](../../docs/adr/0007-function-events.md)) changes the event, as for Node.js, and nothing else: the handler gets the payload itself, any JSON value, unless `FF_EVENT_FORMAT=wrapped`, which every function made before v3 has, and which builds v2's wrapper. The startup line says `"protocol": 3`, with `"eventFormat"`, and the server header `ff-runtime-python/3`.

## What changed in v2

Protocol v2 (2026-10-17, client-readiness plan P-04) keeps v1's HTTP interface, so the backend works with both; a function moves to v2 at its next update. For Python, three things changed, as for Node.js: the out-of-memory replacement is logged; a reload that fails after a crash makes the runtime exit, so that Kubernetes restarts the container, instead of leaving the pod unready for good; and a call waits at most `FF_MAX_QUEUE_WAIT_MS` (one timeout by default) for its turn, then gets 429. The startup line says `"protocol": 2`, and the server header `ff-runtime-python/2`.

## Developing and testing

```bash
cd runtimes/python
python3 -m unittest discover -s tests -v   # L1: 31 protocol tests on real processes, ~10 s, no Docker, no packages
tests/container-smoke.sh                   # L2: builds the image and runs it hardened (read-only, uid 10001, no capabilities)
```

The L1 tests need Python 3.11 or later on the host (for `python -P`).

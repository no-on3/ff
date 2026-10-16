# ff-runtime-python (runtime protocol v1)

The image that runs every Python function on FF. It speaks the same HTTP protocol as [ff-runtime-nodejs](../nodejs/README.md), so the backend treats both runtimes alike. User code is mounted read-only at `/var/task`. Nothing is installed when a function starts.

| | |
|---|---|
| Image | `ff-runtime-python:3.13-v1` (`3.13` = Python 3.13, as in Lambda's `python3.13`; `v1` = runtime protocol) |
| Base | `python:3.13-slim` (Debian, glibc 2.41). Built 2026-10-16 from `sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f` (Python 3.13.16). The tag is deliberately not pinned to a digest, so rebuilds pick up security patches; rebuild regularly. |
| Size | about 119 MB |
| User | `10001:10001` (numeric, so Kubernetes `runAsNonRoot` can verify it) |
| Dependencies | None: the runtime uses only the standard library |
| Footprint | About 22 MB resident for the main process and 15 MB for an idle worker |

glibc rather than Alpine's musl, so `manylinux` wheels built for AWS Lambda also work here.

## How it works

```
main process (main.py)                        worker process (worker.py)
 HTTP :8080  /healthz /readyz /invoke ──────▶ imports /var/task/function.py once
 one invocation at a time (lock + queue)        runs handler(event, context)
 deadline per invocation ── timeout/OOM/exit ─▶ kill + start a fresh worker
```

User code never runs in the main process. A Python thread cannot be stopped from outside, so the worker is a separate process: `python -P -m ff_runtime.worker`, connected to the main process by a socket pair that carries length-prefixed JSON messages (`protocol.py`). A CPU-bound infinite loop, a memory blow-up, or `sys.exit()` only ends the worker. The main process answers probes, reports a Lambda-style error, and starts a new worker. Starting a worker takes about 80 ms plus the import time of the user's module.

`multiprocessing` is not used: its spawn mode starts an extra resource-tracker process in every container and re-imports the main module in the child. A plain subprocess avoids both and exposes the worker's exit status directly.

## HTTP protocol

| Request | Response |
|---|---|
| `GET /healthz` | `200 {"status":"ok"}` while the main process is alive (liveness probe) |
| `GET /readyz` | `200 {"status":"ready"}` once user code is loaded. Otherwise `503 {"status":"starting"}`, or `503 {"status":"failed","error":{errorType,errorMessage}}` (readiness probe) |
| `POST /invoke` | Body = JSON payload (empty means `{}`; `Content-Length` or chunked). Optional header `X-FF-Request-Id`. Returns `200` with the handler's return value as JSON (`null` for `None`). |

**Response headers:** `X-FF-Request-Id`, `X-FF-Duration-Ms`, `X-FF-Max-Memory-Used-Mb`, and `X-FF-Function-Error: Unhandled` on function errors.

**Error responses** (body `{"errorType","errorMessage"}`):

| Status | `errorType` | When |
|---|---|---|
| 500 | The exception's class name (e.g. `ValueError`) | The handler raised |
| 504 | `Sandbox.Timedout` | `Task timed out after X.XX seconds`; the worker is recycled |
| 500 | `Runtime.OutOfMemory` | The worker exceeded its memory limit (see [Memory](#memory)); recycled |
| 500 | `Runtime.ExitError` | User code exited (`sys.exit`, `os._exit`) or crashed the worker: `Runtime exited with error: exit status 3`; recycled |
| 500 | `Runtime.MarshalError` | The return value is not JSON-serializable (a `set`, an object, `NaN`) |
| 500 | `Function.ResponseSizeTooLarge` | Return value above 6 MB |
| 500 | `Runtime.ImportModuleError`, `Runtime.UserCodeSyntaxError`, `Runtime.HandlerNotFound`, `Runtime.MalformedHandlerName`, `Sandbox.Timedout` (init) | User code can't be loaded; `/readyz` stays 503, so Kubernetes never routes to the pod |
| 400 | `InvalidRequestContentException` | Body is not JSON |
| 413 | `RequestEntityTooLargeException` | Body above 6 MB |
| 429 | `TooManyRequestsException` | More than `FF_MAX_QUEUE` invocations waiting |

The error names and messages follow AWS Lambda's (for example `Unable to import module 'function': No module named 'requests'`), so code and tooling port across.

## Handler contract

AWS Lambda's signature:

```python
def handler(event, context):
    ...
# event:   {"body", "headers", "method", "query", "path"}    body = the invoke payload
# context: function_name, function_version, invoked_function_arn (""),
#          memory_limit_in_mb (a string, as on Lambda), aws_request_id,
#          log_group_name (""), log_stream_name (""), identity (None),
#          client_context (None), get_remaining_time_in_millis()
```

- `get_remaining_time_in_millis()` counts down from the start of *this* invocation, not from process start.
- The working directory is the task root (`/var/task`), as on Lambda, so relative paths such as `open("config.json")` work.
- Module-level code runs once per worker, so clients created at import time (database pools, SDK clients) are reused across invocations.
- Return values are serialized with `json.dumps`. `decimal.Decimal` becomes a JSON number (boto3 returns DynamoDB numbers as `Decimal`), and non-ASCII text is sent as UTF-8.
- **Differences from Lambda.** `NaN` and `Infinity` are refused with `Runtime.MarshalError`; Lambda sends them, which is not valid JSON. `async def` handlers are not supported, the same as on Lambda: the coroutine is not JSON-serializable.
- **Code size.** FF currently delivers a single `function.py`, stored in a Kubernetes ConfigMap (900 KiB limit). Packages with vendored dependencies wait for the zip artifact pipeline (parent plan R-02).

## Memory

Two limits apply:

1. **The runtime's own limit.** After user code is loaded, the worker sets `RLIMIT_DATA` to its current data size plus `FUNCTION_MEMORY_LIMIT`. Allocations beyond it raise `MemoryError`. The runtime turns that into `Runtime.OutOfMemory` and replaces the worker, and the container keeps running. The limit counts reserved address space, so it is measured from the loaded state: imports that reserve large buffers still load. Verified with numpy 2.5.4 in a 128 MB function (container limit 256 MB): 2000×2000 matrix products run, with a peak of 135 MB for both processes. A 3000×3000 product gets `Runtime.OutOfMemory`, and the next invocation succeeds on a fresh worker.
2. **The container's memory limit**, set by the Kubernetes manifest. It is the hard limit, and it catches memory the first one misses, for example memory allocated by C extensions. The worker sets its `oom_score_adj` to 1000, so the kernel's OOM killer picks it before the main process. On Kubernetes with cgroup v2, however, the kubelet makes the kernel kill all of a container's processes together (`memory.oom.group = 1`, verified on k3s v1.37.1). In that case the container restarts, and the invocation fails at the proxy.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `LAMBDA_TASK_ROOT` | `/var/task` | Where the user code lives; also the worker's working directory |
| `FF_HANDLER` | `function.handler` | `<module>.<function>`. Subdirectories are allowed: `src/app.handler` imports `src.app` |
| `FUNCTION_TIMEOUT` | `30000` | Invocation timeout in **ms** |
| `FUNCTION_MEMORY_LIMIT` | `128` | MB; sizes the worker's memory limit and sets `context.memory_limit_in_mb` |
| `FUNCTION_NAME`, `FUNCTION_VERSION` | `unknown`, `$LATEST` | Reported in `context` and the logs |
| `FF_INIT_TIMEOUT_MS` | `max(10000, FUNCTION_TIMEOUT)` | Limit for loading user code |
| `FF_MAX_QUEUE` | `32` | Invocations allowed to wait behind the running one |
| `PORT` | `8080` | HTTP port (all IPv6 and IPv4 addresses) |

The function's own environment variables reach user code unchanged.

`os.cpu_count()` reports the node's CPUs, not the function's CPU share (8 in a container limited to half a CPU). Libraries that size thread pools from it, such as numpy's OpenBLAS, then start more threads than the function can use. Set `OPENBLAS_NUM_THREADS` or `OMP_NUM_THREADS` in the function's environment.

## Logs

The user's `print` and `logging` output goes to stdout unchanged. Each invocation adds Lambda-format lines:

```
START RequestId: <id> Version: $LATEST
END RequestId: <id>
REPORT RequestId: <id>	Duration: 12.34 ms	Billed Duration: 13 ms	Memory Size: 128 MB	Max Memory Used: 38 MB
```

`Max Memory Used` is the peak resident memory of the main process plus the worker. Platform events (start, initialization, timeouts, restarts) are one-line JSON. An exception from the handler is also logged as one JSON line with `errorType`, `errorMessage`, and `stackTrace`. **Environment variables are never logged.** On `SIGTERM` the runtime stops accepting connections, finishes the invocations in flight, and exits with status 0.

## Developing and testing

```bash
cd runtimes/python
python3 -m unittest discover -s tests -v   # L1: 22 protocol tests on real processes, ~6 s, no Docker, no packages
tests/container-smoke.sh                   # L2: builds the image and runs it hardened (read-only, uid 10001, no capabilities)
```

The L1 tests need Python 3.11 or later on the host (for `python -P`).

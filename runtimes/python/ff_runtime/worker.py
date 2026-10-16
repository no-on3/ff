"""Worker process that hosts user code (see main.py).

main.py starts it as `python -P -m ff_runtime.worker <socket fd> <main pid>`.
It imports the handler once, then runs one invocation at a time. If it hangs,
runs out of memory, or exits, main.py kills it and starts a fresh one.
"""
import decimal
import importlib
import json
import os
import resource
import signal
import socket
import sys
import time
import traceback

from ff_runtime import protocol
from ff_runtime.protocol import FUNCTION_NAME, FUNCTION_VERSION, HANDLER, MAX_PAYLOAD_BYTES, MEMORY_MB, TASK_ROOT


class InitError(Exception):
    def __init__(self, error_type, message):
        super().__init__(message)
        self.error_type = error_type


class Context:
    """The handler's context argument, with the attributes of AWS Lambda's Python runtime."""

    def __init__(self, request_id, deadline_ms):
        self.function_name = FUNCTION_NAME
        self.function_version = FUNCTION_VERSION
        self.invoked_function_arn = ""
        # A string, as in AWS Lambda's Python runtime.
        self.memory_limit_in_mb = str(MEMORY_MB)
        self.aws_request_id = request_id
        self.log_group_name = ""
        self.log_stream_name = ""
        self.identity = None
        self.client_context = None
        self._deadline_ms = deadline_ms

    def get_remaining_time_in_millis(self):
        return max(0, int(self._deadline_ms - time.time() * 1000))


def die_with_parent(parent_pid):
    """Linux: get SIGKILL when main.py exits, so a busy handler is never orphaned."""
    try:
        import ctypes

        ctypes.CDLL(None).prctl(1, int(signal.SIGKILL))  # PR_SET_PDEATHSIG
    except (OSError, AttributeError):
        return
    if os.getppid() != parent_pid:  # main.py exited before prctl took effect
        os._exit(1)


def prefer_for_oom_kill():
    """If the container runs out of memory, the kernel should kill this process, not main.py."""
    try:
        with open("/proc/self/oom_score_adj", "w") as score:
            score.write("1000")
    except OSError:
        pass


def limit_memory():
    """Make allocations beyond the function's memory raise MemoryError.

    RLIMIT_DATA counts reserved as well as used private memory, so the limit is
    what the loaded code already holds (imports such as numpy reserve large
    buffers) plus the function's memory. The container's memory limit remains
    the hard limit.
    """
    data_kb = protocol.proc_status_kb("VmData")
    if data_kb is None:
        return
    _, hard = resource.getrlimit(resource.RLIMIT_DATA)
    limit = (data_kb + MEMORY_MB * 1024) * 1024
    if hard != resource.RLIM_INFINITY:
        limit = min(limit, hard)
    try:
        resource.setrlimit(resource.RLIMIT_DATA, (limit, hard))
    except (ValueError, OSError):
        pass


def load_handler():
    module_name, separator, attribute = HANDLER.rpartition(".")
    if not separator or not module_name or not attribute:
        raise InitError("Runtime.MalformedHandlerName", f"Bad handler '{HANDLER}': expected <module>.<function>")
    module_name = module_name.replace("/", ".")
    sys.path.insert(0, TASK_ROOT)
    try:
        module = importlib.import_module(module_name)
    except SyntaxError as error:  # includes IndentationError
        raise InitError("Runtime.UserCodeSyntaxError", f"Syntax error in module '{module_name}': {error}") from None
    except Exception as error:  # a missing module or dependency, or user code raised while loading
        raise InitError("Runtime.ImportModuleError", f"Unable to import module '{module_name}': {error}") from None
    handler = getattr(module, attribute, None)
    if not callable(handler):
        raise InitError("Runtime.HandlerNotFound", f"Handler '{attribute}' missing on module '{module_name}'")
    return handler


def to_json(value):
    # boto3 returns DynamoDB numbers as Decimal; AWS Lambda serializes them as numbers.
    if isinstance(value, decimal.Decimal):
        return int(value) if value.is_finite() and value == value.to_integral_value() else float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def log_error(request_id, error):
    frames = traceback.extract_tb(error.__traceback__)[1:]  # without this module's frame
    protocol.log(
        level="error",
        msg="function error",
        requestId=request_id,
        errorType=type(error).__name__,
        errorMessage=str(error),
        stackTrace=[line.rstrip() for line in traceback.format_list(frames)],
    )


def run_once(handler, request_id, event, deadline_ms):
    """Runs one invocation and returns the message for main.py. MemoryError propagates."""
    try:
        value = handler(event, Context(request_id, deadline_ms))
    except MemoryError:
        raise
    except Exception as error:
        log_error(request_id, error)
        return ["error", type(error).__name__, str(error)]
    try:
        # NaN and Infinity are not JSON: refuse them rather than send invalid JSON.
        body = json.dumps(value, default=to_json, ensure_ascii=False, allow_nan=False)
    except MemoryError:
        raise
    except Exception as error:
        return ["error", "Runtime.MarshalError", f"Unable to marshal response: {error}"]
    if len(body.encode()) > MAX_PAYLOAD_BYTES:
        return [
            "error",
            "Function.ResponseSizeTooLarge",
            f"Response payload size exceeded maximum allowed payload size ({MAX_PAYLOAD_BYTES} bytes)",
        ]
    return ["result", body]


def serve(sock, handler):
    while True:
        try:
            _, request_id, event, deadline_ms = protocol.recv(sock)
        except EOFError:
            return  # main.py went away
        try:
            message = run_once(handler, request_id, event, deadline_ms)
        except MemoryError:
            message = None  # leave the except block first so the hoarded memory is released
        if message is None:
            protocol.send(sock, "error", "Runtime.OutOfMemory", "Runtime exceeded its memory limit")
            return  # the heap may be in a bad state: main.py starts a fresh worker
        protocol.send(sock, *message)


def main():
    sock = socket.socket(fileno=int(sys.argv[1]))
    die_with_parent(int(sys.argv[2]))
    sys.argv = sys.argv[:1]
    prefer_for_oom_kill()
    try:
        os.chdir(TASK_ROOT)  # as on AWS Lambda, relative paths resolve against the task root
    except OSError:
        pass
    try:
        handler = load_handler()
    except InitError as error:
        protocol.send(sock, "init_error", error.error_type, str(error))
        return
    limit_memory()
    protocol.send(sock, "ready")
    serve(sock, handler)


if __name__ == "__main__":
    main()

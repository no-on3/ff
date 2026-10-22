"""Worker process that hosts user code (see main.py).

main.py starts it as `python -P -m ff_runtime.worker <socket fd> <main pid>`.
It imports the handler once, then runs one invocation at a time. If it hangs,
runs out of memory, or exits, main.py kills it and starts a fresh one.
"""
import _thread
import decimal
import importlib
import json
import os
import resource
import socket
import sys
import threading
import time
import traceback

from ff_runtime import protocol
from ff_runtime.protocol import FUNCTION_NAME, FUNCTION_VERSION, HANDLER, MAX_PAYLOAD_BYTES, MEMORY_MB, TASK_ROOT

# What the main process may need on top of the worker: an invocation's request
# and reply (up to 6 MB each) are held more than once while being passed on.
MAIN_PROCESS_MARGIN_MB = 32
MIN_BUDGET_MB = 16
# Stacks count toward the memory limit, so Python threads get 2 MB instead of
# the platform's 8 MB. Ten threads (boto3's transfer pool) then cost 20 MB of
# the budget, not 80 MB.
THREAD_STACK_BYTES = 2 * 1024 * 1024


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


def exit_with_parent(parent_pid):
    """Exit once main.py is gone, so a busy handler is never left running.

    In a container main.py is PID 1, and its exit ends every process. This
    covers running elsewhere. PR_SET_PDEATHSIG does not fit: it fires when the
    parent *thread* exits, and replacement workers are started from request
    threads, so a worker would be killed as soon as its connection closed.
    """

    def watch():
        while os.getppid() == parent_pid:
            time.sleep(1)
        os._exit(1)

    _thread.start_new_thread(watch, ())


def prefer_for_oom_kill():
    """If the container runs out of memory, the kernel should kill this process, not main.py."""
    try:
        with open("/proc/self/oom_score_adj", "w") as score:
            score.write("1000")
    except OSError:
        pass


def container_memory_kb():
    """(limit, in use) of this container's memory cgroup; None where unknown or unlimited."""
    try:
        with open("/sys/fs/cgroup/memory.max") as limit, open("/sys/fs/cgroup/memory.current") as current:
            text = limit.read().strip()
            return (None if text == "max" else int(text) // 1024), int(current.read()) // 1024
    except (OSError, ValueError):
        return None, None


def limit_memory():
    """Make allocations beyond the function's memory raise MemoryError.

    The runtime reports that as Runtime.OutOfMemory and replaces the worker.
    Reaching the container's limit instead gets the whole container killed by
    the kernel, and repeated kills put the pod into CrashLoopBackOff.

    The budget is the function's memory (or the container limit, if lower),
    minus what the container already uses and room for the main process.
    RLIMIT_DATA counts reserved as well as used private memory, so the limit is
    the worker's current data size plus that budget: what imports have already
    reserved (numpy's buffers, for example) is not charged again.
    """
    data_kb = protocol.proc_status_kb("VmData")
    if data_kb is None:
        return
    limit_kb, in_use_kb = container_memory_kb()
    if in_use_kb is None:  # not in a container: count the runtime's two processes
        in_use_kb = (protocol.proc_status_kb("VmRSS") or 0) + (protocol.proc_status_kb("VmRSS", os.getppid()) or 0)
    total_kb = MEMORY_MB * 1024 if limit_kb is None else min(MEMORY_MB * 1024, limit_kb)
    budget_kb = max(MIN_BUDGET_MB * 1024, total_kb - in_use_kb - MAIN_PROCESS_MARGIN_MB * 1024)
    _, hard = resource.getrlimit(resource.RLIMIT_DATA)
    limit = (data_kb + budget_kb) * 1024
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
    # As on AWS Lambda: a module compiled into Python (sys, time) would be imported instead of the function's.
    if module_name.split(".")[0] in sys.builtin_module_names:
        raise InitError("Runtime.BuiltInModuleConflict", f"Cannot use built-in module {module_name} as a handler module")
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
    exit_with_parent(int(sys.argv[2]))
    sys.argv = sys.argv[:1]
    prefer_for_oom_kill()
    threading.stack_size(THREAD_STACK_BYTES)
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

"""Shared by main.py and worker.py: settings, limits, logging, and the messages
between the two processes. Runtime protocol v3.

Messages are JSON arrays sent over a socket pair, each prefixed by its length
as a 4-byte big-endian integer:

  main -> worker: ["invoke", request_id, event, deadline_ms]
  worker -> main: ["ready"] | ["init_error", type, message]
                  | ["result", json_text] | ["error", type, message]

The worker's stdout and stderr are pipes that main.py reads and forwards
(output.py): before each "result" or "error", the worker ends the call's output
on both with END_OF_CALL, the call's request ID, and a newline.
"""
import json
import os
import select
import struct
from datetime import datetime, timezone

# AWS Lambda's synchronous request and response limit.
MAX_PAYLOAD_BYTES = 6 * 1024 * 1024
# What the worker writes on its stdout and its stderr once a call's output is all written (output.py).
END_OF_CALL = b"\0ff-end-of-call:"


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


PORT = env_int("PORT", 8080)
TIMEOUT_MS = env_int("FUNCTION_TIMEOUT", 30_000)
MEMORY_MB = env_int("FUNCTION_MEMORY_LIMIT", 128)
INIT_TIMEOUT_MS = env_int("FF_INIT_TIMEOUT_MS", max(10_000, TIMEOUT_MS))
MAX_QUEUE = env_int("FF_MAX_QUEUE", 32)
# How long a call may wait for the worker to be free. Then it gets 429, as on Lambda when no
# environment is free. The backend waits this long plus the timeout, so it never gives up on a
# call that is only queued (client-readiness plan, P-06).
MAX_QUEUE_WAIT_MS = env_int("FF_MAX_QUEUE_WAIT_MS", TIMEOUT_MS)
TASK_ROOT = os.environ.get("LAMBDA_TASK_ROOT", "/var/task")
# "<module>.<function>", e.g. "function.handler" or "src/app.handler".
HANDLER = os.environ.get("FF_HANDLER", "function.handler")
FUNCTION_NAME = os.environ.get("FUNCTION_NAME", "unknown")
FUNCTION_VERSION = os.environ.get("FUNCTION_VERSION", "$LATEST")
# What the handler gets: "lambda", the default, the payload of POST /invoke itself, any JSON value, as on
# AWS Lambda; or "wrapped", FF's original event around it ({body, headers, method, query, path}), for
# functions made before protocol 3.
EVENT_FORMATS = ("lambda", "wrapped")
EVENT_FORMAT = os.environ.get("FF_EVENT_FORMAT", "lambda")


def _print_line(text):
    print(text, flush=True)


# How a line of the runtime's own is written: printed, in the worker; through the Output, in main.py.
_write_line = _print_line


def write_lines_with(write_line):
    """Has log() write its lines with write_line: main.py's Output, which it shares with the worker's output."""
    global _write_line
    _write_line = write_line


def log(**fields):
    """Writes one JSON log line. Never pass environment values."""
    _write_line(json.dumps({"time": datetime.now(timezone.utc).isoformat(), **fields}))


def proc_status_kb(field, pid="self"):
    """A size from /proc/<pid>/status in KiB (e.g. VmHWM), or None where unavailable."""
    try:
        with open(f"/proc/{pid}/status") as status:
            for line in status:
                if line.startswith(field + ":"):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


def send(sock, *message):
    data = json.dumps(message, ensure_ascii=False).encode()
    sock.sendall(struct.pack("!I", len(data)) + data)


def wait_readable(sock, timeout_s):
    """True once a message (or end of file) is waiting; False after timeout_s seconds."""
    poller = select.poll()
    poller.register(sock, select.POLLIN)
    return bool(poller.poll(timeout_s * 1000))


def recv(sock):
    """The next message. Raises EOFError if the other process closed its end."""
    (length,) = struct.unpack("!I", _read_exact(sock, 4))
    return json.loads(_read_exact(sock, length))


def _read_exact(sock, size):
    chunks = []
    while size:
        chunk = sock.recv(min(size, 1 << 20))
        if not chunk:
            raise EOFError("the other process closed the connection")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)

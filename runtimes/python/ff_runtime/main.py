"""FF Python runtime, protocol v3 (the same contract as runtimes/nodejs).

The main process serves HTTP and supervises one worker process that runs user
code (worker.py):

  GET  /healthz   liveness: the main process is responsive
  GET  /readyz    readiness: user code is loaded (503 with the error if not)
  POST /invoke    run the handler once; invocations are serialized, as on Lambda

A timeout, out-of-memory, or crash kills the worker and starts a fresh one, so
even CPU-bound infinite loops are stopped and probes keep answering. If that
fresh worker can't load code that loaded before, the process exits, so that
Kubernetes restarts the container. Environment variables are never logged.
"""
import _thread
import json
import math
import os
import resource
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

from ff_runtime import protocol
from ff_runtime.protocol import (
    FUNCTION_VERSION,
    HANDLER,
    INIT_TIMEOUT_MS,
    MAX_PAYLOAD_BYTES,
    MAX_QUEUE,
    MAX_QUEUE_WAIT_MS,
    MEMORY_MB,
    TIMEOUT_MS,
    log,
)


def start_thread(target, *args):
    """Runs target(*args) on a new daemon thread; RuntimeError if none can be started.

    threading.Thread.start() waits, with no timeout, for the new thread to report
    that it is running. A thread that fails before that (MemoryError when the
    container is short of memory) blocks the caller forever: in the accept loop,
    that stops all requests. The low-level call returns once the thread exists.
    """
    _thread.start_new_thread(target, args)


def fatal(reason):
    """The runtime itself cannot go on: exit, so that Kubernetes restarts the container."""
    try:
        log(level="error", msg="runtime failure; exiting so the container restarts", reason=reason)
    finally:
        os._exit(1)


def crash_error(code):
    """errorType and errorMessage for a worker that exited, worded as AWS Lambda does."""
    if code is not None and code < 0:
        reason = f"signal: {(signal.strsignal(-code) or str(-code)).lower()}"
    else:
        reason = f"exit status {code}"
    # A SIGKILL that main.py did not send comes from the kernel's out-of-memory killer.
    error_type = "Runtime.OutOfMemory" if code == -signal.SIGKILL else "Runtime.ExitError"
    return error_type, f"Runtime exited with error: {reason}"


def memory_used_mb(worker):
    """Peak resident memory of this process plus the worker."""
    own = protocol.proc_status_kb("VmHWM") or resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return max(1, round((own + (protocol.proc_status_kb("VmHWM", worker.pid) or 0)) / 1024))


# A call refused before it ran, as the header says, so that the caller may send it to another instance: the backend does.
NOT_RUN = (503, json.dumps({"errorType": "ServiceUnavailableException", "errorMessage": "Runtime is shutting down"}),
           {"x-ff-not-run": "shutting-down"})
# How long the backend keeps a connection to a function unused before it closes it (kubernetes.orchestrator.ts): a
# runtime that stops waits as long for its callers to close their connections.
CALLER_IDLE_CLOSE_MS = 5000


class Supervisor:
    """Owns the worker process. Invocations run one at a time."""

    def __init__(self):
        self.lock = threading.Condition()  # guards the fields below
        self.running = False  # an invocation runs: the others wait their turn
        self.state = "starting"  # starting | ready | failed
        self.init_error = None
        # The code has loaded at least once: a later load failure is a broken environment, not broken code.
        self.ever_ready = False
        self.pending = 0  # admitted invocations whose response is not written yet
        self.process = None
        self.sock = None
        self.start_worker()

    def start_worker(self):
        try:
            ours, theirs = socket.socketpair()
            process = subprocess.Popen(
                [sys.executable, "-P", "-m", "ff_runtime.worker", str(theirs.fileno()), str(os.getpid())],
                pass_fds=[theirs.fileno()],
                stdin=subprocess.DEVNULL,
            )
        except (OSError, MemoryError) as error:
            fatal(f"cannot start the worker process: {error!r}")
        theirs.close()
        with self.lock:
            self.state, self.init_error = "starting", None
            self.process, self.sock = process, ours
        try:
            start_thread(self._await_init, process, ours)
        except (RuntimeError, MemoryError) as error:
            fatal(f"cannot start a thread: {error!r}")

    @staticmethod
    def stop_worker(process, sock, grace_s=0.0):
        """Kills the worker unless it exits within grace_s seconds; returns its exit code."""
        sock.close()
        try:
            process.wait(grace_s)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                pass
        return process.returncode

    def _await_init(self, process, sock):
        try:
            ready = protocol.wait_readable(sock, INIT_TIMEOUT_MS / 1000)
            message = protocol.recv(sock) if ready else ["init_timeout"]
        except (EOFError, OSError):
            message = ["exited"]
        if message[0] == "ready":
            with self.lock:
                self.state = "ready"
                self.ever_ready = True
                self.lock.notify_all()
            log(level="info", msg="function initialized", handler=HANDLER)
            return
        code = self.stop_worker(process, sock, grace_s=0 if message[0] == "init_timeout" else 2)
        if message[0] == "init_error":
            self._fail(message[1], message[2])
        elif message[0] == "init_timeout":
            self._fail("Sandbox.Timedout", f"Init phase timed out after {INIT_TIMEOUT_MS / 1000:.2f} seconds")
        else:  # exited while loading user code
            self._fail(*crash_error(code))
        with self.lock:
            reload_failed = self.ever_ready
        if reload_failed:
            self._exit_after_failed_reload()

    def _exit_after_failed_reload(self):
        """The code loaded before, so this environment is broken (a reload that timed
        out at 0.1 CPU, for example). /readyz would stay 503 while /healthz stays 200,
        and kubelet would never restart the container: exit instead, once the
        invocations waiting for this worker have had their answer."""
        with self.lock:
            error = dict(self.init_error)
        log(level="error", msg="function reload failed; exiting so the container restarts", **error)

        def exit_soon():
            time.sleep(0.2)
            os._exit(1)

        try:
            start_thread(exit_soon)
        except (RuntimeError, MemoryError):
            os._exit(1)

    def _fail(self, error_type, message):
        """User code cannot be loaded: report it on /readyz and to every caller."""
        with self.lock:
            self.state = "failed"
            self.init_error = {"errorType": error_type, "errorMessage": message}
            self.lock.notify_all()
        log(level="error", msg="function initialization failed", errorType=error_type, errorMessage=message)

    def status(self):
        with self.lock:
            return self.state, self.init_error

    def admit(self):
        """Reserves a place for one invocation, or returns the response that refuses it."""
        with self.lock:
            if SHUTTING_DOWN.is_set():
                return NOT_RUN
            if self.state == "failed":
                return 500, json.dumps(self.init_error), {"x-ff-function-error": "Unhandled"}
            if self.pending > MAX_QUEUE:  # one running plus MAX_QUEUE waiting
                return 429, json.dumps({"errorType": "TooManyRequestsException", "errorMessage": "Rate exceeded"}), {}
            self.pending += 1
            return None

    def release(self):
        with self.lock:
            self.pending -= 1
            self.lock.notify_all()

    def stopping(self):
        """The runtime stops: the calls waiting their turn wake, to be refused."""
        with self.lock:
            self.lock.notify_all()

    def drain(self, timeout_s):
        with self.lock:
            self.lock.wait_for(lambda: self.pending == 0, timeout_s)

    def invoke(self, request_id, event):
        """Runs one admitted invocation. Returns (status, body, headers)."""
        with self.lock:
            # A call still waiting its turn when the runtime stops is refused, never run (see main()).
            if not self.lock.wait_for(lambda: not self.running or SHUTTING_DOWN.is_set(), MAX_QUEUE_WAIT_MS / 1000):
                message = f"Rate exceeded: no instance was free within {MAX_QUEUE_WAIT_MS / 1000:.2f} seconds"
                return 429, json.dumps({"errorType": "TooManyRequestsException", "errorMessage": message}), {}
            if SHUTTING_DOWN.is_set():
                return NOT_RUN
            self.running = True
        try:
            with self.lock:
                # After a timeout or crash, a fresh worker is loading user code.
                self.lock.wait_for(lambda: self.state != "starting", INIT_TIMEOUT_MS / 1000 + 5)
                if self.state != "ready":
                    error = self.init_error or {"errorType": "Runtime.Unavailable", "errorMessage": "Runtime is not ready"}
                    return 500, json.dumps(error), {"x-ff-function-error": "Unhandled"}
                process, sock = self.process, self.sock
            return self._run(process, sock, request_id, event)
        finally:
            with self.lock:
                self.running = False
                self.lock.notify_all()

    def _run(self, process, sock, request_id, event):
        print(f"START RequestId: {request_id} Version: {FUNCTION_VERSION}", flush=True)
        started = time.perf_counter()
        try:
            protocol.send(sock, "invoke", request_id, event, time.time() * 1000 + TIMEOUT_MS)
            message = protocol.recv(sock) if protocol.wait_readable(sock, TIMEOUT_MS / 1000) else ["timeout"]
        except (EOFError, OSError):
            message = ["exited"]
        except MemoryError:  # mid-reply, so the stream is out of step: start a fresh worker
            message = ["error", "Runtime.OutOfMemory", "Runtime exceeded its memory limit"]
        duration_ms = (time.perf_counter() - started) * 1000
        memory_mb = memory_used_mb(process)
        headers = {
            "x-ff-request-id": request_id,
            "x-ff-duration-ms": f"{duration_ms:.2f}",
            "x-ff-max-memory-used-mb": str(memory_mb),
        }

        status, body, replace = 200, message[-1], False
        if message[0] == "error":
            status, error_type, error_message = 500, message[1], message[2]
            replace = error_type == "Runtime.OutOfMemory"  # the worker exits after reporting it
            if replace:  # the same line as the Node.js runtime writes
                log(level="error", msg="function worker crashed; restarting", errorType=error_type,
                    errorMessage=error_message, requestId=request_id)
        elif message[0] == "timeout":
            status, error_type = 504, "Sandbox.Timedout"
            error_message = f"Task timed out after {TIMEOUT_MS / 1000:.2f} seconds"
            log(level="error", msg="task timed out; restarting worker", requestId=request_id, timeoutMs=TIMEOUT_MS)
            self.stop_worker(process, sock)
            replace = True
        elif message[0] == "exited":
            # The socket closes while the interpreter is still exiting: wait for its exit status.
            status, (error_type, error_message) = 500, crash_error(self.stop_worker(process, sock, grace_s=2))
            log(level="error", msg="function worker crashed; restarting", errorType=error_type,
                errorMessage=error_message, requestId=request_id)
            replace = True
        if status != 200:
            headers["x-ff-function-error"] = "Unhandled"
            body = json.dumps({"errorType": error_type, "errorMessage": error_message})
        if replace:
            self.stop_worker(process, sock, grace_s=2)
            self.start_worker()

        print(f"END RequestId: {request_id}", flush=True)
        print(
            f"REPORT RequestId: {request_id}\tDuration: {duration_ms:.2f} ms\t"
            f"Billed Duration: {math.ceil(duration_ms)} ms\tMemory Size: {MEMORY_MB} MB\t"
            f"Max Memory Used: {memory_mb} MB",
            flush=True,
        )
        return status, body, headers


SUPERVISOR = None
SHUTTING_DOWN = threading.Event()


def reject_constant(name):
    raise ValueError(f"{name} is not valid JSON")


class Handler(BaseHTTPRequestHandler):
    server_version = "ff-runtime-python/3"
    protocol_version = "HTTP/1.1"
    timeout = 60  # seconds a connection may sit idle or stall mid-request

    def version_string(self):
        return self.server_version

    def log_message(self, format, *args):  # noqa: A002 - no access logs: URLs may carry data
        pass

    def send_json(self, status, body, headers=None):
        data = (body if isinstance(body, str) else json.dumps(body)).encode()
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            if SHUTTING_DOWN.is_set():
                # While the runtime stops, each answer closes its connection, so that the caller's next call opens a
                # new one, which the Service gives a ready pod: on a connection kept alive, it would come here again.
                self.send_header("connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True  # the client gave up

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            self.send_json(200, {"status": "ok"})
        elif path == "/readyz":
            state, error = SUPERVISOR.status()
            if state == "ready":
                self.send_json(200, {"status": "ready"})
            else:
                self.send_json(503, {"status": state, "error": error} if error else {"status": state})
        else:
            self.not_found()

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/invoke":
            self.not_found()
            return
        try:
            raw = self.read_body()
            body = json.loads(raw, parse_constant=reject_constant) if raw else {}
        except ValueError:
            self.close_connection = True  # the rest of a malformed request cannot be found
            self.send_json(400, {"errorType": "InvalidRequestContentException", "errorMessage": "Could not parse request body into json"})
            return
        if raw is None:
            self.send_json(413, {
                "errorType": "RequestEntityTooLargeException",
                "errorMessage": f"Request must be smaller than {MAX_PAYLOAD_BYTES} bytes",
            })
            return
        refusal = SUPERVISOR.admit()
        if refusal:
            self.send_json(*refusal)
            return
        try:
            event = body if protocol.EVENT_FORMAT == "lambda" else self.wrapped(body, url)
            request_id = self.headers.get("x-ff-request-id") or str(uuid.uuid4())
            self.send_json(*SUPERVISOR.invoke(request_id, event))
        finally:
            SUPERVISOR.release()

    def wrapped(self, body, url):
        """FF's original event, for a function made before protocol 3: the payload in body, the request around it."""
        headers = {}
        for name, value in self.headers.items():
            key = name.lower()
            headers[key] = f"{headers[key]},{value}" if key in headers else value
        return {
            "body": body,
            "headers": headers,
            "method": self.command,
            "query": dict(parse_qsl(url.query, keep_blank_values=True)),
            "path": url.path,
        }

    def read_body(self):
        """The request body, or None when it exceeds the payload limit. ValueError if malformed."""
        if "chunked" in self.headers.get("transfer-encoding", "").lower():
            return self.read_chunked()
        length = int(self.headers.get("content-length") or 0)
        if length < 0:
            raise ValueError("negative content-length")
        if length <= MAX_PAYLOAD_BYTES:
            return self.rfile.read(length)
        if length <= 2 * MAX_PAYLOAD_BYTES:
            self.discard(length)  # keeps the connection usable
        else:
            self.close_connection = True  # do not read abusive uploads
        return None

    def read_chunked(self):
        chunks, size = [], 0
        while True:
            length = int(self.rfile.readline(1024).split(b";")[0].strip(), 16)
            if length == 0:
                while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                    pass  # trailer fields
                return b"".join(chunks) if size <= MAX_PAYLOAD_BYTES else None
            size += length
            if size > 2 * MAX_PAYLOAD_BYTES:
                self.close_connection = True
                return None
            if size <= MAX_PAYLOAD_BYTES:
                chunks.append(self.rfile.read(length))
            else:
                self.discard(length)
            self.rfile.readline(1024)  # the CRLF after the chunk

    def discard(self, size):
        while size > 0:
            chunk = self.rfile.read(min(size, 1 << 16))
            if not chunk:
                return
            size -= len(chunk)

    def not_found(self):
        path = urlsplit(self.path).path
        self.send_json(404, {"errorType": "ResourceNotFoundException", "errorMessage": f"No route for {self.command} {path}"})

    do_PUT = do_PATCH = do_DELETE = not_found


class Server(ThreadingHTTPServer):
    request_queue_size = 128

    def __init__(self, *args):
        self.connections = threading.Condition()  # guards open_connections
        self.open_connections = 0  # which a runtime that stops leaves to their callers to close
        super().__init__(*args)

    def process_request(self, request, client_address):
        self.opened()
        try:
            start_thread(self.connection_thread, request, client_address)
        except (RuntimeError, MemoryError):  # only this connection is lost
            self.shutdown_request(request)
            self.closed()

    def connection_thread(self, request, client_address):
        try:
            self.process_request_thread(request, client_address)
        finally:
            self.closed()

    def opened(self):
        with self.connections:
            self.open_connections += 1

    def closed(self):
        with self.connections:
            self.open_connections -= 1
            self.connections.notify_all()

    def wait_until_closed(self, timeout_s):
        """Until the callers have closed every connection, or timeout_s."""
        with self.connections:
            self.connections.wait_for(lambda: self.open_connections == 0, timeout_s)

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionError, TimeoutError)):
            return  # the client went away: not worth a traceback in the function's logs
        log(level="error", msg="request failed", error=repr(error), stackTrace=traceback.format_exc().splitlines())

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)  # without HTTPServer's reverse DNS lookup
        self.server_name, self.server_port = "localhost", self.server_address[1]


class DualStackServer(Server):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)  # accept IPv4 too
        super().server_bind()


def listen(port):
    """Every IPv6 and IPv4 address, like Node.js; IPv4 only where IPv6 is unavailable."""
    try:
        return DualStackServer(("::", port), Handler)
    except OSError:
        return Server(("0.0.0.0", port), Handler)


def main():
    global SUPERVISOR
    if protocol.EVENT_FORMAT not in protocol.EVENT_FORMATS:
        # A function given the wrong event would fail at every call, or worse, misread it: refuse to start instead.
        log(level="error", msg="unknown FF_EVENT_FORMAT", expected=list(protocol.EVENT_FORMATS))
        sys.exit(1)
    server = listen(protocol.PORT)
    SUPERVISOR = Supervisor()

    def on_signal(signum, _frame):
        if SHUTTING_DOWN.is_set():
            return
        SHUTTING_DOWN.set()
        log(level="info", msg="shutting down; draining invocations", signal=signal.Signals(signum).name,
            inFlight=SUPERVISOR.pending)
        try:
            start_thread(stop)
        except (RuntimeError, MemoryError):
            os._exit(0)

    def stop():
        SUPERVISOR.stopping()
        server.shutdown()  # serve_forever() returns

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    log(level="info", msg="runtime listening", port=protocol.PORT, timeoutMs=TIMEOUT_MS, maxQueueWaitMs=MAX_QUEUE_WAIT_MS,
        memoryLimitMb=MEMORY_MB, handler=HANDLER, protocol=3, eventFormat=protocol.EVENT_FORMAT)
    server.serve_forever()
    # Kubernetes stops the runtime to replace or remove its pod. New connections are refused, and go to another instance.
    # The call running is answered; every other one, waiting or still to come, is refused as never run, and the backend
    # sends it to another instance. Each answer closes its connection, and the runtime closes no other: a call could be
    # on its way on one, and would be lost. The callers close them, the backend each one it leaves unused for
    # CALLER_IDLE_CLOSE_MS. The runtime exits once nothing runs and no connection is open, or when the time for both is up.
    server.server_close()
    deadline = time.monotonic() + max(TIMEOUT_MS, CALLER_IDLE_CLOSE_MS) / 1000 + 1
    SUPERVISOR.drain(deadline - time.monotonic())
    server.wait_until_closed(deadline - time.monotonic())
    with SUPERVISOR.lock:
        process, sock = SUPERVISOR.process, SUPERVISOR.sock
    SUPERVISOR.stop_worker(process, sock)


if __name__ == "__main__":
    main()

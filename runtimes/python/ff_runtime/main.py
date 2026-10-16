"""FF Python runtime, protocol v1 (the same contract as runtimes/nodejs).

The main process serves HTTP and supervises one worker process that runs user
code (worker.py):

  GET  /healthz   liveness: the main process is responsive
  GET  /readyz    readiness: user code is loaded (503 with the error if not)
  POST /invoke    run the handler once; invocations are serialized, as on Lambda

A timeout, out-of-memory, or crash kills the worker and starts a fresh one, so
even CPU-bound infinite loops are stopped and probes keep answering.
Environment variables are never logged.
"""
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
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

from ff_runtime import protocol
from ff_runtime.protocol import FUNCTION_VERSION, HANDLER, INIT_TIMEOUT_MS, MAX_PAYLOAD_BYTES, MAX_QUEUE, MEMORY_MB, TIMEOUT_MS, log


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


class Supervisor:
    """Owns the worker process. Invocations run one at a time."""

    def __init__(self):
        self.lock = threading.Condition()  # guards the fields below
        self.exec_lock = threading.Lock()  # held while an invocation runs
        self.state = "starting"  # starting | ready | failed
        self.init_error = None
        self.pending = 0  # admitted invocations whose response is not written yet
        self.process = None
        self.sock = None
        self.start_worker()

    def start_worker(self):
        ours, theirs = socket.socketpair()
        process = subprocess.Popen(
            [sys.executable, "-P", "-m", "ff_runtime.worker", str(theirs.fileno()), str(os.getpid())],
            pass_fds=[theirs.fileno()],
            stdin=subprocess.DEVNULL,
        )
        theirs.close()
        with self.lock:
            self.state, self.init_error = "starting", None
            self.process, self.sock = process, ours
        threading.Thread(target=self._await_init, args=(process, ours), daemon=True).start()

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

    def drain(self, timeout_s):
        with self.lock:
            self.lock.wait_for(lambda: self.pending == 0, timeout_s)

    def invoke(self, request_id, event):
        """Runs one admitted invocation. Returns (status, body, headers)."""
        with self.exec_lock:
            with self.lock:
                # After a timeout or crash, a fresh worker is loading user code.
                self.lock.wait_for(lambda: self.state != "starting", INIT_TIMEOUT_MS / 1000 + 5)
                if self.state != "ready":
                    error = self.init_error or {"errorType": "Runtime.Unavailable", "errorMessage": "Runtime is not ready"}
                    return 500, json.dumps(error), {"x-ff-function-error": "Unhandled"}
                process, sock = self.process, self.sock
            return self._run(process, sock, request_id, event)

    def _run(self, process, sock, request_id, event):
        print(f"START RequestId: {request_id} Version: {FUNCTION_VERSION}", flush=True)
        started = time.perf_counter()
        try:
            protocol.send(sock, "invoke", request_id, event, time.time() * 1000 + TIMEOUT_MS)
            message = protocol.recv(sock) if protocol.wait_readable(sock, TIMEOUT_MS / 1000) else ["timeout"]
        except (EOFError, OSError):
            message = ["exited"]
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
    server_version = "ff-runtime-python/1"
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
        if SHUTTING_DOWN.is_set():
            self.send_json(503, {"errorType": "ServiceUnavailableException", "errorMessage": "Runtime is shutting down"})
            return
        refusal = SUPERVISOR.admit()
        if refusal:
            self.send_json(*refusal)
            return
        try:
            headers = {}
            for name, value in self.headers.items():
                key = name.lower()
                headers[key] = f"{headers[key]},{value}" if key in headers else value
            event = {
                "body": body,
                "headers": headers,
                "method": self.command,
                "query": dict(parse_qsl(url.query, keep_blank_values=True)),
                "path": url.path,
            }
            request_id = self.headers.get("x-ff-request-id") or str(uuid.uuid4())
            self.send_json(*SUPERVISOR.invoke(request_id, event))
        finally:
            SUPERVISOR.release()

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
    daemon_threads = True
    request_queue_size = 128

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
    server = listen(protocol.PORT)
    SUPERVISOR = Supervisor()

    def on_signal(signum, _frame):
        if SHUTTING_DOWN.is_set():
            return
        SHUTTING_DOWN.set()
        log(level="info", msg="shutting down; draining invocations", signal=signal.Signals(signum).name,
            inFlight=SUPERVISOR.pending)
        threading.Thread(target=server.shutdown, daemon=True).start()  # stop accepting connections

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    log(level="info", msg="runtime listening", port=protocol.PORT, timeoutMs=TIMEOUT_MS, memoryLimitMb=MEMORY_MB,
        handler=HANDLER, protocol=1)
    server.serve_forever()
    SUPERVISOR.drain(TIMEOUT_MS / 1000 + 1)
    with SUPERVISOR.lock:
        process, sock = SUPERVISOR.process, SUPERVISOR.sock
    SUPERVISOR.stop_worker(process, sock)


if __name__ == "__main__":
    main()

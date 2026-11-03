"""L1 tests for the runtime protocol: each test starts `python -m ff_runtime.main`
against one fixture on a free port. No Docker needed.

Run from runtimes/python:  python3 -m unittest discover -s tests -v
"""
import base64
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT))  # for the in-process tests


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Result:
    def __init__(self, status, text, headers):
        self.status, self.text, self.headers = status, text, headers

    @property
    def json(self):
        return json.loads(self.text) if self.text else None


def exchange(connection, method, path, body=None, headers=None):
    """One request on this connection, which stays open for the next unless the runtime closes it."""
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    text = response.read().decode()
    return Result(response.status, text, {name.lower(): value for name, value in response.getheaders()})


class Runtime:
    def __init__(self, fixture, env):
        self.port = free_port()
        self.process = subprocess.Popen(
            [sys.executable, "-P", "-m", "ff_runtime.main"],
            cwd=ROOT,
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "PYTHONPATH": str(ROOT),
                "PYTHONUNBUFFERED": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PORT": str(self.port),
                "LAMBDA_TASK_ROOT": str(FIXTURES / fixture),
                "FUNCTION_NAME": fixture,
                "FUNCTION_TIMEOUT": "1000",
                "FUNCTION_MEMORY_LIMIT": "128",
                **env,
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,  # so stop() can kill the worker as well
        )
        self._logs = []
        self._collector = threading.Thread(target=self._collect_logs, daemon=True)
        self._collector.start()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                if self.request("GET", "/healthz").status == 200:
                    return
            except OSError:
                time.sleep(0.05)
        self.stop()
        raise AssertionError(f"runtime for {fixture} did not start:\n{self.logs()}")

    def _collect_logs(self):
        for line in self.process.stdout:
            self._logs.append(line.decode(errors="replace"))

    def logs(self):
        return "".join(self._logs)

    def log_lines(self, msg):
        """The runtime's one-line JSON logs whose msg is `msg`."""
        lines = [json.loads(line) for line in self.logs().splitlines() if line.startswith("{")]
        return [line for line in lines if line.get("msg") == msg]

    def exit_code(self, wait_s):
        """The exit code once the process exits, or None if it still runs after wait_s seconds."""
        try:
            return self.process.wait(wait_s)
        except subprocess.TimeoutExpired:
            return None

    def stop(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(10)
        self._collector.join(5)
        self.process.stdout.close()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            return exchange(connection, method, path, body, headers)
        finally:
            connection.close()

    def invoke(self, body, headers=None, path="/invoke"):
        data = body if isinstance(body, (str, bytes)) else json.dumps(body)
        data = data.encode() if isinstance(data, str) else data
        return self.request("POST", path, data, {"content-type": "application/json", **(headers or {})})

    def readyz_until(self, predicate, timeout=5):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.request("GET", "/readyz")
            if predicate(last.status, last.json):
                return last
            time.sleep(0.05)
        raise AssertionError(f"readyz never reached the expected state; last: {last and (last.status, last.text)}")

    def ready(self, timeout=5):
        return self.readyz_until(lambda status, _: status == 200, timeout)

    def failed(self, timeout=5):
        # 503 is also returned while starting, so wait for the terminal state.
        return self.readyz_until(lambda _, body: body["status"] == "failed", timeout)


class RuntimeTest(unittest.TestCase):
    def start(self, fixture, **env):
        runtime = Runtime(fixture, env)
        self.addCleanup(runtime.stop)
        return runtime

    def assertFunctionError(self, result, status, error_type, message=None):
        self.assertEqual(result.status, status, result.text)
        self.assertEqual(result.json["errorType"], error_type)
        if message:
            self.assertRegex(result.json["errorMessage"], message)
        self.assertEqual(result.headers.get("x-ff-function-error"), "Unhandled")


class SuccessfulInvocations(RuntimeTest):
    def test_passes_event_and_context_and_writes_lambda_style_logs(self):
        rt = self.start("hello", FF_TEST_GREETING="marhba")
        rt.ready()

        res = rt.invoke({"name": "FF"}, {"x-ff-request-id": "req-123"})

        self.assertEqual(res.status, 200)
        self.assertEqual(res.json["message"], "Hello FF")
        self.assertEqual(res.json["functionName"], "hello")
        self.assertEqual(res.json["memoryLimitInMB"], "128")
        self.assertEqual(res.json["requestId"], "req-123")
        self.assertTrue(0 < res.json["remainingMs"] <= 1000, res.json["remainingMs"])
        self.assertEqual(res.json["cwd"], str(FIXTURES / "hello"))  # the task root, as on Lambda
        self.assertEqual(res.json["greeting"], "marhba")  # function environment reaches user code
        self.assertEqual(res.headers["x-ff-request-id"], "req-123")
        self.assertGreaterEqual(float(res.headers["x-ff-duration-ms"]), 0)
        self.assertGreater(int(res.headers["x-ff-max-memory-used-mb"]), 0)
        self.assertNotIn("x-ff-function-error", res.headers)
        logs = rt.logs()
        self.assertIn("hello from user code", logs)
        self.assertRegex(logs, r"START RequestId: req-123 Version: \$LATEST")
        self.assertRegex(logs, r"END RequestId: req-123")
        self.assertRegex(logs, r"REPORT RequestId: req-123\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 128 MB")

    def test_hands_the_payload_to_the_handler_as_the_event_itself_any_json_value(self):
        rt = self.start("echo")
        rt.ready()

        for payload in ({"a": 1}, "text", 42, [1, "two"], None, True):
            res = rt.invoke(json.dumps(payload))
            self.assertEqual(res.status, 200, res.text)
            self.assertEqual(res.json, {"echo": payload})
        self.assertRegex(res.headers["x-ff-request-id"], r"^[0-9a-f-]{36}$")

    def test_wraps_the_payload_in_the_original_event_for_a_function_made_before_protocol_3(self):
        rt = self.start("echo", FF_EVENT_FORMAT="wrapped")
        rt.ready()

        res = rt.invoke({"a": 1}, {"x-ff-request-id": "req-wrapped"}, path="/invoke?x=1&empty=")

        self.assertEqual(res.status, 200)
        echo = res.json["echo"]
        self.assertEqual(
            (echo["body"], echo["method"], echo["path"], echo["query"]), ({"a": 1}, "POST", "/invoke", {"x": "1", "empty": ""})
        )
        self.assertEqual(echo["headers"]["x-ff-request-id"], "req-wrapped")

    def test_refuses_to_start_with_an_event_format_it_does_not_know(self):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": str(ROOT), "PORT": str(free_port()),
               "LAMBDA_TASK_ROOT": str(FIXTURES / "echo"), "FF_EVENT_FORMAT": "v2"}
        done = subprocess.run([sys.executable, "-P", "-m", "ff_runtime.main"], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)

        self.assertEqual(done.returncode, 1)
        self.assertIn('"msg": "unknown FF_EVENT_FORMAT", "expected": ["lambda", "wrapped"]', done.stdout)

    def test_imports_a_handler_in_a_folder_of_the_package_as_aws_lambda_does(self):
        rt = self.start("subfolder", FF_HANDLER="src/handlers/orders.create")
        rt.ready()

        res = rt.invoke({"id": 7})

        self.assertEqual(res.status, 200, res.text)
        self.assertEqual(res.json, {"created": 7, "module": "src.handlers.orders"})

    def test_returns_json_null_when_the_handler_returns_none(self):
        rt = self.start("void")
        rt.ready()

        res = rt.invoke({})

        self.assertEqual(res.status, 200)
        self.assertEqual(res.text, "null")

    def test_treats_an_empty_request_body_as_an_empty_object(self):
        rt = self.start("echo")
        rt.ready()

        self.assertEqual(rt.invoke("").json["echo"], {})

    def test_accepts_a_chunked_request_body(self):
        rt = self.start("echo")
        rt.ready()

        res = rt.request("POST", "/invoke", iter([b'{"a":', b' [1, 2]}']), {"content-type": "application/json"})

        self.assertEqual(res.status, 200)
        self.assertEqual(res.json["echo"], {"a": [1, 2]})

    def test_serializes_decimal_as_numbers_and_keeps_unicode(self):
        rt = self.start("types")
        rt.ready()

        res = rt.invoke({})

        self.assertEqual(res.json, {"price": 9.99, "count": 3, "city": "تونس"})
        self.assertIn("تونس", res.text)

    def test_serializes_concurrent_invocations_one_at_a_time_as_on_lambda(self):
        rt = self.start("slow-echo")
        rt.ready()

        with ThreadPoolExecutor(2) as pool:
            first, second = pool.map(lambda n: rt.invoke({"n": n}), [1, 2])

        self.assertEqual((first.status, second.status), (200, 200))
        a, b = sorted([first.json, second.json], key=lambda r: r["start"])
        self.assertGreaterEqual(b["start"], a["end"], f"overlap: {a} {b}")


class FunctionErrors(RuntimeTest):
    def test_maps_a_raised_exception_to_500_and_logs_its_traceback(self):
        rt = self.start("throws")
        rt.ready()

        res = rt.invoke({})

        self.assertFunctionError(res, 500, "TypeError")
        self.assertEqual(res.json, {"errorType": "TypeError", "errorMessage": "bad input"})
        error_log = next(json.loads(line) for line in rt.logs().splitlines() if '"function error"' in line)
        self.assertEqual(error_log["errorType"], "TypeError")
        self.assertIn("function.py", error_log["stackTrace"][0])

    def test_rejects_responses_above_6_mb(self):
        rt = self.start("big-response")
        rt.ready()

        self.assertFunctionError(rt.invoke({}), 500, "Function.ResponseSizeTooLarge")

    def test_reports_values_json_cannot_represent_as_runtime_marshal_error(self):
        rt = self.start("unserializable")
        rt.ready()

        self.assertFunctionError(rt.invoke({}), 500, "Runtime.MarshalError", r"Object of type set is not JSON serializable")
        self.assertFunctionError(rt.invoke({"kind": "nan"}), 500, "Runtime.MarshalError")


class Recycling(RuntimeTest):
    """Timeouts and crashes kill the worker and start a fresh one."""

    def test_times_out_with_sandbox_timedout(self):
        rt = self.start("timeout", FUNCTION_TIMEOUT="500")
        rt.ready()

        started = time.monotonic()
        res = rt.invoke({})
        elapsed = time.monotonic() - started

        self.assertFunctionError(res, 504, "Sandbox.Timedout")
        self.assertEqual(res.json["errorMessage"], "Task timed out after 0.50 seconds")
        self.assertTrue(0.45 <= elapsed < 1.5, f"elapsed={elapsed:.3f}s")

    def test_stops_a_cpu_bound_loop_keeps_probes_responsive_and_recovers(self):
        rt = self.start("busy-loop", FUNCTION_TIMEOUT="700")
        rt.ready()

        with ThreadPoolExecutor(1) as pool:
            spinning = pool.submit(rt.invoke, {"spin": True})
            time.sleep(0.2)
            health = rt.request("GET", "/healthz")  # the main process must still answer
            res = spinning.result()
        rt.ready()  # a fresh worker was started
        after = rt.invoke({"spin": False})

        self.assertEqual(health.status, 200)
        self.assertFunctionError(res, 504, "Sandbox.Timedout")
        self.assertEqual((after.status, after.json), (200, "ok"))

    def test_a_replacement_worker_outlives_the_connection_that_replaced_it(self):
        # Replacement workers are started from request threads. A worker tied to
        # that thread (PR_SET_PDEATHSIG fires when the parent *thread* exits)
        # died when the connection closed, and the next invocation failed.
        rt = self.start("busy-loop", FUNCTION_TIMEOUT="500")
        rt.ready()
        connection = HTTPConnection("127.0.0.1", rt.port, timeout=30)
        connection.request("POST", "/invoke", b'{"spin": true}', {"content-type": "application/json"})
        timed_out = connection.getresponse()
        timed_out.read()
        rt.ready()  # the replacement has loaded the function
        connection.close()  # so the request thread that started it exits
        time.sleep(0.5)

        after = rt.invoke({"spin": False})

        self.assertEqual(timed_out.status, 504)
        self.assertEqual((after.status, after.json), (200, "ok"))

    def test_reports_running_out_of_memory_as_runtime_out_of_memory_and_recovers(self):
        rt = self.start("oom", FUNCTION_MEMORY_LIMIT="64", FUNCTION_TIMEOUT="10000")
        rt.ready()

        res = rt.invoke({}, {"x-ff-request-id": "req-oom"})
        ready = rt.ready()

        self.assertFunctionError(res, 500, "Runtime.OutOfMemory")
        self.assertEqual(ready.status, 200)
        # The replacement is logged, as the Node.js runtime does.
        self.assertEqual(
            [(line["errorType"], line["requestId"]) for line in rt.log_lines("function worker crashed; restarting")],
            [("Runtime.OutOfMemory", "req-oom")],
        )

    def test_budgets_the_function_memory_minus_what_the_runtime_uses(self):
        rt = self.start("allocate", FUNCTION_MEMORY_LIMIT="256", FUNCTION_TIMEOUT="10000")
        rt.ready()

        fits = rt.invoke({"mb": 120})
        too_big = rt.invoke({"mb": 230})  # 256 MB minus the runtime's ~35 MB and its 32 MB margin is less
        rt.ready()
        after = rt.invoke({"mb": 50})

        self.assertEqual((fits.status, fits.json), (200, 120))
        self.assertFunctionError(too_big, 500, "Runtime.OutOfMemory")
        self.assertEqual((after.status, after.json), (200, 50))

    def test_runs_ten_threads_in_a_128_mb_function(self):
        rt = self.start("threads")
        rt.ready()

        res = rt.invoke({})

        self.assertEqual(res.status, 200, res.text)
        self.assertEqual(res.json, {"threads": 10, "stackSize": 2 * 1024 * 1024})

    def test_reports_sys_exit_as_runtime_exit_error_and_recovers(self):
        rt = self.start("exit")
        rt.ready()

        res = rt.invoke({})
        ready = rt.ready()

        self.assertFunctionError(res, 500, "Runtime.ExitError", r"Runtime exited with error: exit status 3")
        self.assertEqual(ready.status, 200)


class InitFailures(RuntimeTest):
    """User code that cannot be loaded keeps the pod unready."""

    CASES = [
        ("init-error", {}, "Runtime.ImportModuleError", r"Unable to import module 'function': boom at init"),
        ("syntax-error", {}, "Runtime.UserCodeSyntaxError", r"Syntax error in module 'function'"),
        ("no-handler", {}, "Runtime.HandlerNotFound", r"Handler 'handler' missing on module 'function'"),
        ("empty", {}, "Runtime.ImportModuleError", r"No module named 'function'"),
        ("missing-dep", {}, "Runtime.ImportModuleError", r"No module named 'ff_missing_dependency'"),
        ("hello", {"FF_HANDLER": "handler"}, "Runtime.MalformedHandlerName", r"Bad handler 'handler'"),
        ("hello", {"FF_HANDLER": "sys.handler"}, "Runtime.BuiltInModuleConflict", r"^Cannot use built-in module sys as a handler module$"),
    ]

    def test_reports_the_error_on_readyz_and_invoke(self):
        for fixture, env, error_type, message in self.CASES:
            with self.subTest(fixture=fixture, env=env):
                rt = Runtime(fixture, env)
                try:
                    failed = rt.failed()
                    res = rt.invoke({})
                    # A first load that fails is the code's fault: the runtime stays up and reports it.
                    still_running = rt.exit_code(0.3) is None
                finally:
                    rt.stop()
                self.assertTrue(still_running)
                self.assertEqual(failed.status, 503)
                self.assertEqual(failed.json["error"]["errorType"], error_type)
                self.assertRegex(failed.json["error"]["errorMessage"], message)
                self.assertFunctionError(res, 500, error_type, message)

    def test_exits_so_the_container_restarts_when_a_replacement_cannot_load_code_that_loaded_before(self):
        marker_dir = tempfile.TemporaryDirectory(prefix="ff-rt-")
        self.addCleanup(marker_dir.cleanup)
        rt = self.start("reload-fails", FF_TEST_MARKER=os.path.join(marker_dir.name, "loaded"))
        rt.ready()

        crashed = rt.invoke({"crash": True})
        code = rt.exit_code(5)

        self.assertFunctionError(crashed, 500, "Runtime.ExitError", r"exit status 3")
        self.assertEqual(code, 1)
        self.assertEqual(
            [line["errorMessage"] for line in rt.log_lines("function reload failed; exiting so the container restarts")],
            ["Unable to import module 'function': reload fails"],
        )

    def test_fails_initialization_that_never_finishes_with_sandbox_timedout(self):
        rt = self.start("init-hang", FF_INIT_TIMEOUT_MS="500")

        health = rt.request("GET", "/healthz")  # the hang is confined to the worker
        failed = rt.failed(timeout=3)

        self.assertEqual(health.status, 200)
        self.assertEqual(failed.status, 503)
        self.assertEqual(failed.json["error"]["errorType"], "Sandbox.Timedout")
        self.assertRegex(failed.json["error"]["errorMessage"], r"Init phase timed out after 0\.50 seconds")


class RequestValidation(RuntimeTest):
    def test_rejects_bodies_above_6_mb_with_413(self):
        rt = self.start("echo")
        rt.ready()

        res = rt.invoke(json.dumps({"data": "x" * (6 * 1024 * 1024 + 1)}))

        self.assertEqual(res.status, 413)
        self.assertEqual(res.json["errorType"], "RequestEntityTooLargeException")

    def test_rejects_invalid_json_with_400(self):
        rt = self.start("echo")
        rt.ready()

        for body in ["{not json", '{"a": NaN}']:
            with self.subTest(body=body):
                res = rt.invoke(body)
                self.assertEqual(res.status, 400)
                self.assertEqual(res.json["errorType"], "InvalidRequestContentException")

    def test_returns_429_when_the_queue_is_full(self):
        rt = self.start("slow-echo", FF_MAX_QUEUE="1")
        rt.ready()

        # One runs, one waits in the queue, the third overflows it.
        with ThreadPoolExecutor(3) as pool:
            results = list(pool.map(lambda n: rt.invoke({"n": n}), [1, 2, 3]))

        self.assertEqual(sorted(r.status for r in results), [200, 200, 429])

    def test_answers_429_to_a_call_that_waited_longer_than_the_queue_wait_limit(self):
        rt = self.start("slow-echo", FF_MAX_QUEUE_WAIT_MS="100")  # each call takes 200 ms
        rt.ready()

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda n: rt.invoke({"n": n}), [1, 2]))

        self.assertEqual(sorted(r.status for r in results), [200, 429])
        throttled = next(r for r in results if r.status == 429)
        self.assertEqual(
            throttled.json,
            {"errorType": "TooManyRequestsException", "errorMessage": "Rate exceeded: no instance was free within 0.10 seconds"},
        )

    def test_lets_a_call_wait_at_most_one_function_timeout_by_default(self):
        rt = self.start("slow-echo", FUNCTION_TIMEOUT="300")  # each call takes 200 ms
        rt.ready()

        # The second call waits about 200 ms, the third about 400 ms: more than the 300 ms timeout.
        with ThreadPoolExecutor(3) as pool:
            results = list(pool.map(lambda n: rt.invoke({"n": n}), [1, 2, 3]))

        self.assertEqual(sorted(r.status for r in results), [200, 200, 429])

    def test_answers_unknown_routes_with_404(self):
        rt = self.start("echo")

        self.assertEqual(rt.request("GET", "/nope").status, 404)
        self.assertEqual(rt.request("GET", "/invoke").status, 404)
        self.assertEqual(rt.request("PUT", "/invoke", b"{}").status, 404)


class Lifecycle(RuntimeTest):
    def test_sigterm_finishes_the_invocation_in_flight_then_exits(self):
        rt = self.start("slow-echo")
        rt.ready()

        with ThreadPoolExecutor(1) as pool:
            in_flight = pool.submit(rt.invoke, {"n": 1})
            time.sleep(0.05)
            rt.process.send_signal(signal.SIGTERM)
            res = in_flight.result()
        code = rt.process.wait(5)

        self.assertEqual(res.status, 200)
        self.assertEqual(code, 0)
        self.assertIn("shutting down; draining invocations", rt.logs())

    REFUSED = (503, {"errorType": "ServiceUnavailableException", "errorMessage": "Runtime is shutting down"}, "shutting-down", "close")

    @staticmethod
    def not_run(res):
        return res.status, res.json, res.headers.get("x-ff-not-run"), res.headers.get("connection")

    def test_refuses_at_once_as_never_run_a_call_waiting_its_turn_and_closes_both_connections(self):
        rt = self.start("slow-echo")  # each call takes 200 ms
        rt.ready()

        def answered(n):
            res = rt.invoke({"n": n})
            return res, time.monotonic()

        with ThreadPoolExecutor(2) as pool:
            running = pool.submit(answered, 1)
            time.sleep(0.025)
            waiting = pool.submit(answered, 2)
            time.sleep(0.025)
            rt.process.send_signal(signal.SIGTERM)
            (answer, answered_at), (refusal, refused_at) = running.result(), waiting.result()
        code = rt.exit_code(2)

        self.assertEqual((answer.status, answer.json["n"], answer.headers.get("connection")), (200, 1, "close"))
        self.assertEqual(self.not_run(refusal), self.REFUSED)
        self.assertLess(refused_at, answered_at, "the call waiting was refused only after the one before it ended")
        self.assertEqual(code, 0)

    def test_leaves_an_idle_connection_for_its_caller_to_close_and_refuses_a_call_on_it_as_never_run(self):
        rt = self.start("echo")
        rt.ready()
        idle = HTTPConnection("127.0.0.1", rt.port, timeout=10)
        self.addCleanup(idle.close)
        call = {"body": json.dumps({"n": 1}).encode(), "headers": {"content-type": "application/json"}}
        before = exchange(idle, "POST", "/invoke", **call)

        rt.process.send_signal(signal.SIGTERM)
        waited_for = rt.exit_code(0.8)
        refuses_new_connections = self.refuses_new_connections(rt)
        on_the_idle_one = exchange(idle, "POST", "/invoke", **call)
        code = rt.exit_code(2)

        self.assertEqual(before.status, 200)
        self.assertIsNone(waited_for, "the runtime exited with a connection still open, which a call could have been crossing")
        self.assertTrue(refuses_new_connections)
        self.assertEqual(self.not_run(on_the_idle_one), self.REFUSED)
        self.assertEqual(code, 0)

    def test_exits_at_once_when_it_runs_nothing_and_no_connection_is_open(self):
        rt = self.start("echo")
        rt.ready()

        rt.process.send_signal(signal.SIGTERM)

        self.assertEqual(rt.exit_code(1.5), 0)

    @staticmethod
    def refuses_new_connections(rt, within_s=2):
        """Once its accept loop has seen the signal, within half a second; until then, a probe is answered and closed."""
        deadline = time.monotonic() + within_s
        while time.monotonic() < deadline:
            try:
                rt.request("GET", "/healthz")
            except ConnectionRefusedError:
                return True
            time.sleep(0.05)
        return False


class AcceptLoop(unittest.TestCase):
    """The HTTP server itself, in this process."""

    def test_a_connection_thread_that_fails_to_start_does_not_stop_the_server(self):
        # Short of memory, a new thread can fail before it reports that it is
        # running. threading.Thread.start() then waits forever, which once
        # stopped the accept loop for good (seen under gVisor).
        from ff_runtime import main

        server = main.listen(0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(lambda: threading.Thread(target=server.shutdown, daemon=True).start())

        with mock.patch.object(threading.Thread, "_bootstrap_inner", side_effect=MemoryError):
            first = self.healthz(server.server_address[1])
        second = self.healthz(server.server_address[1])

        self.assertEqual((first, second), (200, 200))

    @staticmethod
    def healthz(port):
        connection = HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request("GET", "/healthz")
            return connection.getresponse().status
        except OSError as error:
            return repr(error)
        finally:
            connection.close()


def outside_their_call(output, request_ids):
    """The lines of each call, which start with its ID, found outside its START and END."""
    lines = output.splitlines()
    outside = []
    for request_id in request_ids:
        start = lines.index(f"START RequestId: {request_id} Version: $LATEST")
        end = lines.index(f"END RequestId: {request_id}")
        outside += [line for at, line in enumerate(lines) if line.startswith(f"{request_id}:") and not start < at < end]
    return outside


class CallOutput(RuntimeTest):
    """The log store tags each line with the call between its pod's START and REPORT lines (ADR 0005), so a line that
    came after END would go untagged. The worker's output reaches the container's through the main process, which
    prints END once the worker has marked the end of the call's output on both streams."""

    def test_writes_every_line_of_a_call_before_its_end_on_stdout_and_stderr_and_never_the_end_of_call_markers(self):
        rt = self.start("output", FUNCTION_TIMEOUT="5000")
        rt.ready()

        # Calls that write mostly to stdout, and calls that write only to stderr: END waits for both streams.
        calls = [(f"req-order-{i}", {"lines": 0, "errors": 20, "open": False} if i % 2 else {"lines": 20, "errors": 1})
                 for i in range(1, 21)]
        for request_id, body in calls:
            self.assertEqual(rt.invoke(body, {"x-ff-request-id": request_id}).status, 200)

        output = rt.logs()
        self.assertNotIn("ff-end-of-call", output, "an end-of-call marker reached the output")
        self.assertEqual(outside_their_call(output, [request_id for request_id, _ in calls]), [], output)

    def test_starts_its_own_lines_on_a_line_of_their_own_when_the_call_left_one_open_and_adds_no_empty_line_otherwise(self):
        rt = self.start("output", FUNCTION_TIMEOUT="5000")
        rt.ready()

        rt.invoke({"lines": 1, "errors": 0}, {"x-ff-request-id": "req-open"})
        rt.invoke({"lines": 1, "errors": 0, "open": False}, {"x-ff-request-id": "req-closed"})

        output = rt.logs()
        self.assertRegex(output, r"\nreq-open: line 1\nreq-open: left open\nEND RequestId: req-open\nREPORT RequestId: req-open\t")
        self.assertRegex(output, r"\nSTART RequestId: req-closed Version: \$LATEST\nreq-closed: line 1\nEND RequestId: req-closed\nREPORT ")

    def test_writes_what_a_call_wrote_before_its_timeout_ahead_of_the_timeout_and_its_end(self):
        rt = self.start("output", FUNCTION_TIMEOUT="500")
        rt.ready()

        res = rt.invoke({"lines": 3, "errors": 1, "open": False, "hangMs": 3000}, {"x-ff-request-id": "req-late"})

        self.assertFunctionError(res, 504, "Sandbox.Timedout")
        lines = rt.logs().splitlines()
        timed_out = next(at for at, line in enumerate(lines) if '"msg": "task timed out; restarting worker"' in line)
        written = [at for at, line in enumerate(lines) if line.startswith("req-late:")]
        self.assertEqual(len(written), 4, lines)  # three lines on stdout, one on stderr
        self.assertLess(max(written), timed_out)
        self.assertLess(timed_out, lines.index("END RequestId: req-late"))


class WhatLambdasCallerAsksFor(RuntimeTest):
    """A caller of Lambda's Invoke may ask for the call's last 4 KB of log, which the log store has only seconds later,
    and may say who it is, in a client context the handler reads."""

    @staticmethod
    def tail_of(res):
        return base64.b64decode(res.headers.get("x-ff-log-result", "")).decode(errors="replace")

    def test_gives_back_the_call_s_log_from_its_start_to_its_report_both_streams_when_asked_and_nothing_when_not(self):
        rt = self.start("output", FUNCTION_TIMEOUT="5000")
        rt.ready()

        asked = rt.invoke({"lines": 2, "errors": 1}, {"x-ff-request-id": "req-tail", "x-ff-log-type": "Tail"})
        not_asked = rt.invoke({"lines": 1}, {"x-ff-request-id": "req-none"})

        self.assertEqual(asked.status, 200)
        lines = self.tail_of(asked).split("\n")
        self.assertEqual(lines[0], "START RequestId: req-tail Version: $LATEST")
        # Each stream's lines come whole, in either stream's order, through pipes of their own; the line left open last.
        self.assertEqual(sorted(lines[1:4]), ["req-tail: error 1", "req-tail: line 1", "req-tail: line 2"])
        self.assertEqual(lines[4:6], ["req-tail: left open", "END RequestId: req-tail"])
        self.assertRegex(lines[6], r"^REPORT RequestId: req-tail\tDuration: [\d.]+ ms\t.*\tMax Memory Used: \d+ MB$")
        self.assertEqual(lines[7:], [""])
        self.assertNotIn("x-ff-log-result", not_asked.headers)

    def test_keeps_a_long_call_s_last_4_kb_its_report_last(self):
        rt = self.start("output", FUNCTION_TIMEOUT="5000")
        rt.ready()

        res = rt.invoke({"lines": 400, "errors": 0, "open": False}, {"x-ff-request-id": "req-long", "x-ff-log-type": "Tail"})

        tail = base64.b64decode(res.headers["x-ff-log-result"])
        self.assertEqual(len(tail), 4096)
        self.assertNotIn(b"START RequestId", tail)
        self.assertRegex(tail.decode(), r"req-long: line 400\nEND RequestId: req-long\nREPORT RequestId: req-long\t[^\n]+\n$")

    def test_gives_back_the_log_of_a_call_that_raised_with_its_error_and_of_one_that_timed_out_with_the_timeout(self):
        raises = self.start("throws")
        times_out = self.start("timeout", FUNCTION_TIMEOUT="300")
        raises.ready()
        times_out.ready()

        raised = raises.invoke({}, {"x-ff-request-id": "req-raised", "x-ff-log-type": "Tail"})
        late = times_out.invoke({}, {"x-ff-request-id": "req-late", "x-ff-log-type": "Tail"})

        self.assertFunctionError(raised, 500, "TypeError")
        self.assertRegex(self.tail_of(raised),
                         r'"msg": "function error", "requestId": "req-raised", "errorType": "TypeError"[^\n]*\nEND RequestId: req-raised\n')
        self.assertFunctionError(late, 504, "Sandbox.Timedout")
        self.assertRegex(self.tail_of(late), r'(?s)"msg": "task timed out; restarting worker", "requestId": "req-late".*\nEND RequestId: req-late\n')

    def test_hands_the_caller_s_client_context_to_the_handler_as_lambda_s_objects_and_refuses_one_that_is_no_json_object(self):
        rt = self.start("client-context")
        rt.ready()
        said = {"client": {"installation_id": "i-1", "app_title": "shop"}, "custom": {"cart": "7"}, "env": {"locale": "ar-TN"}}

        def header(text):
            return {"x-ff-client-context": base64.b64encode(text.encode()).decode()}

        given = rt.invoke({}, header(json.dumps(said)))
        without_client = rt.invoke({}, header(json.dumps({"custom": {"cart": "8"}})))
        none = rt.invoke({})
        refusals = [rt.invoke({}, header(text)) for text in ("not json", "[1]", "null", "NaN")]
        unpadded = rt.invoke({}, {"x-ff-client-context": "e30"})  # "{}", its padding left out, as Lambda takes it

        self.assertEqual(given.json, {
            "custom": {"cart": "7"},
            "env": {"locale": "ar-TN"},
            "client": {"installation_id": "i-1", "app_title": "shop", "app_version_name": None, "app_version_code": None,
                       "app_package_name": None},
            "slots": False,
        })
        self.assertEqual(without_client.json, {"custom": {"cart": "8"}, "env": None, "client": None, "slots": False})
        self.assertIsNone(none.json)
        self.assertEqual(unpadded.json, {"custom": None, "env": None, "client": None, "slots": False})
        message = "Client context must be a valid Base64-encoded JSON object."
        for res in refusals:
            self.assertEqual((res.status, res.json["errorType"], res.json["errorMessage"]), (400, "InvalidRequestContentException", message))


class OutputMerging(unittest.TestCase):
    """The worker's two streams and the runtime's lines, merged line by line as the container's log reads them, and
    as the log of a call a caller of Lambda's Invoke asks for keeps them, its last 4 KB."""

    def setUp(self):
        from ff_runtime.output import LogTail, Output
        self.written = []  # (fd, data) as written, in order: one log reading both streams
        self.output = Output(write=lambda fd, data: self.written.append((fd, bytes(data))) or len(data))
        self.tail = LogTail()
        self.output.keep_tail(self.tail)

    def log(self):
        return b"".join(data for _, data in self.written).decode()

    def tail_text(self):
        return base64.b64decode(self.tail.base64()).decode()

    def test_keeps_a_line_written_in_parts_whole_the_other_stream_s_lines_after_it(self):
        # Unbuffered, the worker's print writes its text, then its newline, and the pipe may give them apart.
        self.output.line("START")
        self.output.forward("stdout", b"line 3")
        self.output.forward("stderr", b"an error\n")
        self.output.forward("stdout", b"\nthree, ")
        self.output.forward("stdout", b"four\n")
        self.output.line("END")

        self.assertEqual(self.log(), "START\nan error\nline 3\nthree, four\nEND\n")
        self.assertEqual(self.tail_text(), self.log())
        self.assertEqual([fd for fd, _ in self.written], [1, 2, 1, 1, 1])

    def test_ends_the_lines_the_streams_left_open_before_the_runtime_s_own_and_at_the_stream_s_end(self):
        self.output.forward("stdout", b"open on stdout")
        self.output.forward("stderr", b"open on stderr")
        self.output.line("END")
        self.output.forward("stderr", b"the worker's last words")
        self.output.end_stream("stderr")
        self.output.line("REPORT")

        self.assertEqual(self.log(), "open on stdout\nopen on stderr\nEND\nthe worker's last words\nREPORT\n")
        self.assertEqual(self.tail_text(), self.log())

    def test_writes_a_line_left_open_past_its_bound_as_it_is_and_gives_back_the_last_4_kb(self):
        from ff_runtime.output import HELD_LINE_BYTES, LOG_TAIL_BYTES
        self.output.forward("stdout", b"x" * (3 * LOG_TAIL_BYTES))
        self.assertEqual(self.written, [])  # held, within its bound
        self.output.forward("stdout", b"x" * HELD_LINE_BYTES)
        self.assertEqual(len(self.log()), 3 * LOG_TAIL_BYTES + HELD_LINE_BYTES)  # past it, written as it is
        self.output.line("END")
        kept = base64.b64decode(self.tail.base64())

        self.assertEqual(len(kept), LOG_TAIL_BYTES)
        self.assertEqual(kept, b"x" * (LOG_TAIL_BYTES - len(b"\nEND\n")) + b"\nEND\n")


class Secrets(RuntimeTest):
    def test_never_writes_environment_variables_to_the_logs(self):
        sentinel = "s3cr3t-value-7f1d"
        rt = self.start("hello", DATABASE_PASSWORD=sentinel)
        rt.ready()

        rt.invoke({"name": "x"})
        rt.invoke({}, {"x-ff-request-id": "after"})

        self.assertNotIn(sentinel, rt.logs(), "an environment value leaked into the logs")


if __name__ == "__main__":
    unittest.main()

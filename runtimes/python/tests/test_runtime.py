"""L1 tests for the runtime protocol: each test starts `python -m ff_runtime.main`
against one fixture on a free port. No Docker needed.

Run from runtimes/python:  python3 -m unittest discover -s tests -v
"""
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"


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

    def stop(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(10)
        self._collector.join(5)
        self.process.stdout.close()

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            text = response.read().decode()
            return Result(response.status, text, {name.lower(): value for name, value in response.getheaders()})
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

    def test_generates_a_request_id_and_passes_method_path_and_query(self):
        rt = self.start("echo")
        rt.ready()

        res = rt.invoke({"a": 1}, path="/invoke?x=1&empty=")

        self.assertEqual(res.status, 200)
        self.assertEqual(res.json, {"echo": {"a": 1}, "method": "POST", "path": "/invoke", "query": {"x": "1", "empty": ""}})
        self.assertRegex(res.headers["x-ff-request-id"], r"^[0-9a-f-]{36}$")

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

    def test_reports_running_out_of_memory_as_runtime_out_of_memory_and_recovers(self):
        rt = self.start("oom", FUNCTION_MEMORY_LIMIT="64", FUNCTION_TIMEOUT="10000")
        rt.ready()

        res = rt.invoke({})
        ready = rt.ready()

        self.assertFunctionError(res, 500, "Runtime.OutOfMemory")
        self.assertEqual(ready.status, 200)

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
    ]

    def test_reports_the_error_on_readyz_and_invoke(self):
        for fixture, env, error_type, message in self.CASES:
            with self.subTest(fixture=fixture, env=env):
                rt = Runtime(fixture, env)
                try:
                    failed = rt.failed()
                    res = rt.invoke({})
                finally:
                    rt.stop()
                self.assertEqual(failed.status, 503)
                self.assertEqual(failed.json["error"]["errorType"], error_type)
                self.assertRegex(failed.json["error"]["errorMessage"], message)
                self.assertFunctionError(res, 500, error_type, message)

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

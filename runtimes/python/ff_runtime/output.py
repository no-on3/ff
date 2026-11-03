"""The runtime's output (see main.py): the worker's stdout and stderr, which come
through pipes and are forwarded as they come, and the runtime's own lines.

The log store tags a call's lines from its START to its REPORT (ADR 0005), so a
call's output must come before its END. The worker marks the end of each call's
output on both streams (protocol.END_OF_CALL), after what the call wrote; main.py
prints END once both markers have come, or both streams have ended, the worker
gone. The markers never reach the output.
"""
import os
import threading

from ff_runtime.protocol import END_OF_CALL

STREAMS = {"stdout": 1, "stderr": 2}
# Calls whose markers are kept for main.py to wait on: a marker that came after its call's wait ended is dropped.
KEPT_CALLS = 16


def held_from(data):
    """Where a marker, whole or only begun, starts at the end of the data; its length when none does."""
    whole = data.find(END_OF_CALL)
    if whole >= 0:
        return whole
    for at in range(max(0, len(data) - len(END_OF_CALL) + 1), len(data)):
        if END_OF_CALL.startswith(data[at:]):
            return at
    return len(data)


class Output:
    """This process's stdout and stderr, written from several threads: the worker's output and the runtime's lines."""

    def __init__(self):
        self.lock = threading.Lock()
        # Whether the last write to a stream left a line open: the runtime's own lines start a line of their own.
        self.open_line = {stream: False for stream in STREAMS}

    def line(self, text):
        """One of the runtime's own lines, on stdout, after any line the worker's output left open there."""
        with self.lock:
            self._write("stdout", (b"\n" if self.open_line["stdout"] else b"") + text.encode() + b"\n")

    def forward(self, stream, data):
        """The worker's output, as it came."""
        if data:
            with self.lock:
                self._write(stream, data)

    def _write(self, stream, data):
        self.open_line[stream] = not data.endswith(b"\n")
        fd = STREAMS[stream]
        try:
            while data:
                data = data[os.write(fd, data):]
        except OSError:
            pass  # the container's output is gone: nothing to write it to


class WorkerStreams:
    """One worker's stdout and stderr, each read by a thread of its own through a pipe and forwarded to the Output."""

    def __init__(self, output, start_thread):
        self.output = output
        self.condition = threading.Condition()
        self.marked = {}  # a call's ID: the streams whose marker for it came
        self.ended = set()  # the streams at their end: the worker is gone
        self.pipes = {}
        for stream in STREAMS:
            read_end, write_end = os.pipe()
            self.pipes[stream] = write_end
            start_thread(self._relay, stream, read_end)

    def give_worker(self):
        """The ends the worker writes to, as its stdout and stderr, for subprocess.Popen."""
        return self.pipes["stdout"], self.pipes["stderr"]

    def worker_started(self):
        """Closes this process's copies of the worker's ends, so that each stream ends when the worker does."""
        for write_end in self.pipes.values():
            os.close(write_end)
        self.pipes = {}

    def wait_for_call(self, call_id, timeout_s):
        """Waits until both streams carried the call's marker, or ended; False after timeout_s seconds."""
        with self.condition:
            done = self.condition.wait_for(lambda: len(self.marked.get(call_id, set()) | self.ended) == len(STREAMS), timeout_s)
            self.marked.pop(call_id, None)
            return done

    def wait_for_end(self, timeout_s):
        """Waits until both streams ended, the worker gone; False after timeout_s seconds."""
        with self.condition:
            return self.condition.wait_for(lambda: len(self.ended) == len(STREAMS), timeout_s)

    def _mark(self, call_id, stream):
        with self.condition:
            self.marked.setdefault(call_id, set()).add(stream)
            while len(self.marked) > KEPT_CALLS:
                self.marked.pop(next(iter(self.marked)))
            self.condition.notify_all()

    def _relay(self, stream, read_end):
        carry = b""
        try:
            while True:
                chunk = os.read(read_end, 65536)
                if not chunk:
                    break
                data = carry + chunk
                while True:
                    at = data.find(END_OF_CALL)
                    end = data.find(b"\n", at) if at >= 0 else -1
                    if end < 0:
                        break  # no marker, or its ID isn't all here yet
                    self.output.forward(stream, data[:at])
                    self._mark(data[at + len(END_OF_CALL):end].decode(errors="replace"), stream)
                    data = data[end + 1:]
                held = held_from(data)
                self.output.forward(stream, data[:held])
                carry = data[held:]
        except OSError:
            pass
        finally:
            self.output.forward(stream, carry)  # the worker is gone: what was held back is its output
            os.close(read_end)
            with self.condition:
                self.ended.add(stream)
                self.condition.notify_all()

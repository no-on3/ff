"""The runtime's output (see main.py): the worker's stdout and stderr, which come
through pipes and are forwarded as they come, and the runtime's own lines.

The log store tags a call's lines from its START to its REPORT (ADR 0005), so a
call's output must come before its END. The worker marks the end of each call's
output on both streams (protocol.END_OF_CALL), after what the call wrote; main.py
prints END once both markers have come, or both streams have ended, the worker
gone. The markers never reach the output.

Both streams are merged line by line: the worker runs unbuffered, so a line can
come in parts, and a line a stream left open waits for its end before it is
written, so that the other stream's lines and the runtime's never split it in a
log that reads both. When the caller asks for a call's log (X-FF-Log-Type: Tail),
the Output keeps what it writes from the call's START to its REPORT in a LogTail.
"""
import base64
import os
import threading

from ff_runtime.protocol import END_OF_CALL

STREAMS = {"stdout": 1, "stderr": 2}
# Calls whose markers are kept for main.py to wait on: a marker that came after its call's wait ended is dropped.
KEPT_CALLS = 16
# How much of a call's log Lambda gives back with LogType Tail: its last 4 KB.
LOG_TAIL_BYTES = 4096
# The most of a line a stream may leave open before it is written as it is, as the container's runtime splits a
# longer line too: a line held longer would keep the call's output from the log for as long.
HELD_LINE_BYTES = 16384


def held_from(data):
    """Where a marker, whole or only begun, starts at the end of the data; its length when none does."""
    whole = data.find(END_OF_CALL)
    if whole >= 0:
        return whole
    for at in range(max(0, len(data) - len(END_OF_CALL) + 1), len(data)):
        if END_OF_CALL.startswith(data[at:]):
            return at
    return len(data)


class LogTail:
    """A call's log as this process writes it, both streams as the Output merges them: its last LOG_TAIL_BYTES, which
    base64() gives as Lambda's X-Amz-Log-Result."""

    def __init__(self):
        self.data = b""

    def keep(self, data):
        self.data = (self.data + data)[-LOG_TAIL_BYTES:]

    def base64(self):
        return base64.b64encode(self.data).decode()


class Output:
    """This process's stdout and stderr, written from several threads, the worker's output and the runtime's lines,
    merged line by line: a line a stream left open is held until its end, the runtime's next line, which ends it
    first, or the stream's end."""

    def __init__(self, write=os.write):
        self.lock = threading.Lock()
        self.write = write
        self.open = {stream: b"" for stream in STREAMS}  # what each stream wrote of a line it hasn't ended yet
        self.unended = set()  # the streams whose last write left its line open: one past HELD_LINE_BYTES
        self.tail = None  # the log of the call running, when its caller asked for it

    def keep_tail(self, tail):
        """What is written from now on goes to tail as well; None stops it."""
        with self.lock:
            self.tail = tail

    def line(self, text):
        """One of the runtime's own lines, on stdout, after each line the worker's output left open, ended."""
        with self.lock:
            for stream in STREAMS:
                self._end_open_line(stream)
            self._write("stdout", text.encode() + b"\n")

    def forward(self, stream, data):
        """The worker's output: its lines as they end, a line left open held, unless it grew past HELD_LINE_BYTES."""
        if data:
            with self.lock:
                held = self.open[stream] + data
                end = held.rfind(b"\n") + 1
                if len(held) - end > HELD_LINE_BYTES:
                    end = len(held)
                self.open[stream] = held[end:]
                self._write(stream, held[:end])

    def end_stream(self, stream):
        """The worker's stream ended, the worker gone: the line it left open, ended."""
        with self.lock:
            self._end_open_line(stream)

    def _end_open_line(self, stream):
        held, self.open[stream] = self.open[stream], b""
        if held or stream in self.unended:
            self._write(stream, held + b"\n")

    def _write(self, stream, data):
        if not data:
            return
        if data.endswith(b"\n"):
            self.unended.discard(stream)
        else:
            self.unended.add(stream)
        if self.tail is not None:
            self.tail.keep(data)
        fd = STREAMS[stream]
        try:
            while data:
                data = data[self.write(fd, data):]
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
            self.output.end_stream(stream)
            os.close(read_end)
            with self.condition:
                self.ended.add(stream)
                self.condition.notify_all()

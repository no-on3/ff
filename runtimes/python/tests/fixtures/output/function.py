"""Writes as a busy handler might, just before it returns: lines on stdout and on stderr and, unless told not to,
a line left open on stdout. With `hangMs`, it writes a line, then runs past its timeout."""
import sys
import time


def handler(event, context):
    request_id = context.aws_request_id
    for i in range(1, event.get("lines", 20) + 1):
        print(f"{request_id}: line {i}")
    for i in range(1, event.get("errors", 1) + 1):
        print(f"{request_id}: error {i}", file=sys.stderr)
    if event.get("open", True):
        sys.stdout.write(f"{request_id}: left open")
    if event.get("hangMs"):
        time.sleep(event["hangMs"] / 1000)
    return "ok"

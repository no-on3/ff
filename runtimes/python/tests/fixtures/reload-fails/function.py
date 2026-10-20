"""Loads once. After the worker crashes, its replacement can't load it any more,
as when the environment breaks: the marker file says it loaded before."""
import os

MARKER = os.environ["FF_TEST_MARKER"]
if os.path.exists(MARKER):
    raise RuntimeError("reload fails")
with open(MARKER, "w") as marker:
    marker.write("loaded")


def handler(event, context):
    if event["body"].get("crash"):
        os._exit(3)
    return "ok"

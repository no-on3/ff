import time


def handler(event, context):
    start = time.time() * 1000
    time.sleep(0.2)
    return {"n": event["body"]["n"], "start": start, "end": time.time() * 1000}

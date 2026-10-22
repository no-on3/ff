import time


# Sleeps for event["seconds"] seconds. Longer than the function's timeout ends as TIMEOUT.
def handler(event, context):
    seconds = event.get("seconds", 1)
    time.sleep(seconds)
    return {"slept": seconds, "remainingMs": context.get_remaining_time_in_millis()}

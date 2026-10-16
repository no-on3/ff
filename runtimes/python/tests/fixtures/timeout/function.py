import time


def handler(event, context):
    time.sleep(10)
    return "too late"

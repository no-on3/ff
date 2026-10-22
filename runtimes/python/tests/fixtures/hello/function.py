import os


def handler(event, context):
    print("hello from user code")
    return {
        "message": f"Hello {event.get('name', 'world')}",
        "functionName": context.function_name,
        "memoryLimitInMB": context.memory_limit_in_mb,
        "requestId": context.aws_request_id,
        "remainingMs": context.get_remaining_time_in_millis(),
        "cwd": os.getcwd(),
        "greeting": os.environ.get("FF_TEST_GREETING"),
    }

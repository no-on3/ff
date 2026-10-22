def handler(event, context):
    data = bytearray(event["mb"] * 1024 * 1024)
    return len(data) // (1024 * 1024)

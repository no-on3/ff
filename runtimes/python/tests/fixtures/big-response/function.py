def handler(event, context):
    return "x" * (7 * 1024 * 1024)  # 7 MB: above the 6 MB response limit

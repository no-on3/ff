def handler(event, context):
    return {"echo": event["body"], "method": event["method"], "path": event["path"], "query": event["query"]}

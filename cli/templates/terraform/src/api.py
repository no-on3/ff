# {{name}}'s API, called through its URL with Lambda's event for one (its payload's version 2.0); the answer is
# the URL's: a status, headers and a body.
import json
import os


def handler(event, context):
    http = event.get("requestContext", {}).get("http", {})
    body = {"app": os.environ.get("APP"), "method": http.get("method"), "path": event.get("rawPath")}
    return {"statusCode": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}

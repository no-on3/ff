# {{name}}: a function in Python, with AWS Lambda's handler: FF calls handler(event, context),
# and event is what the caller sent, as a payload is on Lambda. The code moves to Lambda as it is.
def handler(event, context):
    name = event.get("name", "world")
    print(f"greeting {name}")  # a line of the function's log: ff logs {{name}}
    return {"message": f"Hello {name}", "requestId": context.aws_request_id}

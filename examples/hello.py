# A Python function. FF calls handler(event, context), as AWS Lambda does.
# event["body"] is the "input" sent to POST /functions/:id/invoke.
def handler(event, context):
    name = event["body"].get("name", "world")
    if name == "error":
        raise ValueError("this name is not allowed")  # the invocation ends as ERROR
    print(f"greeting {name}")  # shows up in the function pod's logs
    return {"message": f"Hello {name}", "requestId": context.aws_request_id}

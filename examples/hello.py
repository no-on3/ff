# A Python function. FF calls handler(event, context), as AWS Lambda does.
# The event is the "input" sent to POST /functions/:id/invoke, as a payload is on AWS Lambda.
def handler(event, context):
    name = event.get("name", "world")
    if name == "error":
        raise ValueError("this name is not allowed")  # the invocation ends as ERROR
    print(f"greeting {name}")  # shows up in the function pod's logs
    return {"message": f"Hello {name}", "requestId": context.aws_request_id}

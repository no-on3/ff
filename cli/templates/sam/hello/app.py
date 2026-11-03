# {{name}}'s function: AWS Lambda's handler, which FF calls as Lambda does. Its URL's calls bring the query in
# queryStringParameters; ff invoke's, the event itself. STAGE comes from the template.
import os


def handler(event, context):
    name = (event.get("queryStringParameters") or {}).get("name") or event.get("name", "world")
    print(f"greeting {name}")  # a line of the function's log: ff logs <its name>
    return {"message": f"Hello {name}", "stage": os.environ.get("STAGE")}

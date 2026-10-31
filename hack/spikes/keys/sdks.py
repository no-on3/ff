"""boto3 past its key's end: one call to each of S3, SQS, SES and Lambda at ENDPOINT, which answers each as the
service answers a key that has expired (expired.mjs), the key and region from the environment as a function's pod
has them. One JSON line per service: what boto3 raised, the HTTP status, the retries it made and the requests the
endpoint counted, and how long the call took, its own retries and waits included.
  ENDPOINT=http://127.0.0.1:<port> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=… python sdks.py
"""
import json
import os
import time
import urllib.request

import boto3
from botocore.exceptions import ClientError

endpoint = os.environ["ENDPOINT"]


def counts():
    with urllib.request.urlopen(f"{endpoint}/count") as answer:
        return json.load(answer)


calls = {
    "s3": lambda: boto3.client("s3", endpoint_url=endpoint).get_object(Bucket="spike", Key="k"),
    "sqs": lambda: boto3.client("sqs", endpoint_url=endpoint).list_queues(),
    "ses": lambda: boto3.client("sesv2", endpoint_url=endpoint).get_account(),
    "lambda": lambda: boto3.client("lambda", endpoint_url=endpoint).get_function(FunctionName="spike"),
}

for service, call in calls.items():
    before = counts().get(service, 0)
    started = time.monotonic()
    line = {"sdk": "boto3", "service": service}
    try:
        call()
        line["threw"] = "nothing"
    except ClientError as error:
        line.update(
            threw=f"ClientError {error.response['Error'].get('Code')}",
            message=error.response["Error"].get("Message"),
            status=error.response["ResponseMetadata"].get("HTTPStatusCode"),
            retries=error.response["ResponseMetadata"].get("RetryAttempts"),
        )
    except Exception as error:  # what boto3 raises before it sends anything, the request never made
        line.update(threw=type(error).__name__, message=str(error))
    line["requests"] = counts().get(service, 0) - before
    line["ms"] = round((time.monotonic() - started) * 1000)
    print(json.dumps(line), flush=True)

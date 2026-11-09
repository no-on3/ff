# {{name}}'s API, at its function's URL: POST /jobs takes a job, {"task": "…", …}, into the queue, and answers 202
# with its ID; the worker does it later. The event is Lambda's URL event (version 2.0) and the answer a URL's
# response, the same on FF and on AWS Lambda. JOBS_QUEUE_URL names the queue, as template.yaml sets it; boto3 finds
# its endpoint and its key in the function's environment, on FF as on AWS.
import base64
import json
import os
import re

# The largest job, as SQS's largest message is 256 KiB.
MOST_BYTES = 262_144
JOBS = re.compile(r"/jobs/?")


class Invalid(Exception):
    """A request that can't be taken: its answer is 400 with the message."""


def handler(event, context):
    return route(event, send)


def route(event, send):
    """The request's answer, the job given to `send` to put in the queue: the tests give their own."""
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    if not JOBS.fullmatch(path):
        return answer(404, {"message": f"No route for {path}"})
    if method != "POST":
        return answer(405, {"message": f"{path} takes POST, not {method}"}, {"allow": "POST"})
    try:
        job = job_of(event)
    except Invalid as error:
        return answer(400, {"message": str(error)})
    return answer(202, {"id": send(json.dumps(job, ensure_ascii=False)), "task": job["task"]})


def job_of(event):
    text = event.get("body") or ""
    if event.get("isBase64Encoded"):
        text = base64.b64decode(text).decode("utf-8")
    if len(text.encode()) > MOST_BYTES:
        raise Invalid(f"A job is {MOST_BYTES} bytes at most, as SQS's messages")
    try:
        job = json.loads(text)
    except ValueError:
        raise Invalid('The body is JSON: {"task": "…"}')
    if not isinstance(job, dict):
        raise Invalid('A job is an object: {"task": "…"}')
    task = job.get("task")
    if not isinstance(task, str) or not 0 < len(task) <= 100:
        raise Invalid('A job names its task, {"task": "…"}, 1 to 100 characters')
    return job


def answer(status, body, headers=None):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", **(headers or {})},
        "body": json.dumps(body, ensure_ascii=False),
    }


# The queue's client, made at the first call and kept for the calls after.
_queue = None


def send(body):
    global _queue
    if _queue is None:
        url = os.environ.get("JOBS_QUEUE_URL")
        if not url:
            raise RuntimeError("JOBS_QUEUE_URL is not set: template.yaml sets it to the queue it makes")
        # Loaded here, so that the tests run without it installed.
        import boto3

        _queue = (boto3.client("sqs"), url)
    sqs, url = _queue
    return sqs.send_message(QueueUrl=url, MessageBody=body)["MessageId"]

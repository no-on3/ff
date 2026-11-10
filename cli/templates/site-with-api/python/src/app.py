# {{name}}'s API, at its function's URL, which the page in site/ calls: a guestbook, each entry an object of its
# bucket. The event is Lambda's URL event (version 2.0) and the answer a URL's response, the same on FF and on AWS
# Lambda.
#   GET  /entries   the latest 20 entries, the newest first
#   POST /entries   {"name": "…", "message": "…"}: the entry kept, 201 with it
# ENTRIES_BUCKET names the bucket; boto3 finds its endpoint and its key in the function's environment, on FF as on
# AWS. The browser's CORS is the URL's, as template.yaml sets it: this code never answers a preflight.
import base64
import json
import os
import re
import secrets
from datetime import datetime, timedelta, timezone


class Invalid(Exception):
    """A request that can't be taken: its answer is 400 with the message."""


# How many entries GET /entries gives, the newest first.
LATEST = 20
# The last millisecond an entry's ID counts down from, in the year 2286: 13 digits.
LAST_MILLISECOND = 9_999_999_999_999
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
ENTRIES = re.compile(r"/entries/?")


def handler(event, context):
    return route(event, entries())


def route(event, bucket):
    """The request's answer, the entries kept in `bucket`: the tests give their own."""
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    if not ENTRIES.fullmatch(path):
        return answer(404, {"message": f"No route for {path}"})
    if method == "GET":
        return answer(200, latest(bucket))
    if method != "POST":
        return answer(405, {"message": f"{path} takes GET, POST, not {method}"}, {"allow": "GET, POST"})
    try:
        return answer(201, kept(bucket, entry_of(event)))
    except Invalid as error:
        return answer(400, {"message": str(error)})


def id_of(date, random=None):
    """An entry's ID, made at `date`: the milliseconds left until LAST_MILLISECOND, then a random part, so that the
    bucket, which lists its keys in order, lists the newest first."""
    milliseconds = (date - EPOCH) // timedelta(milliseconds=1)
    return f"{LAST_MILLISECOND - milliseconds:013d}-{random or secrets.token_hex(4)}"


def latest(bucket):
    return [json.loads(bucket.get(key)) for key in bucket.keys("entries/", LATEST)]


def kept(bucket, fields):
    now = datetime.now(timezone.utc)
    at = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    entry = {"id": id_of(now), **fields, "at": at}
    bucket.put(f"entries/{entry['id']}.json", json.dumps(entry, ensure_ascii=False))
    return entry


def entry_of(event):
    text = event.get("body") or ""
    if event.get("isBase64Encoded"):
        text = base64.b64decode(text).decode("utf-8")
    try:
        body = json.loads(text)
    except ValueError:
        raise Invalid('The body is JSON: {"name": "…", "message": "…"}')
    if not isinstance(body, dict):
        raise Invalid('An entry is an object: {"name": "…", "message": "…"}')
    return {"name": text_of(body.get("name"), "a name", 50), "message": text_of(body.get("message"), "a message", 500)}


def text_of(value, what, most):
    """A field's text, trimmed, between 1 and `most` characters."""
    text = value.strip() if isinstance(value, str) else ""
    if not 0 < len(text) <= most:
        raise Invalid(f"An entry has {what}, 1 to {most} characters")
    return text


def answer(status, body, headers=None):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", **(headers or {})},
        "body": json.dumps(body, ensure_ascii=False),
    }


class Bucket:
    """The entries' bucket, through boto3: its first keys under a prefix, an object read, an object written."""

    def __init__(self, name):
        # Loaded here, so that the tests run without it installed.
        import boto3

        self.name = name
        self.s3 = boto3.client("s3")

    def keys(self, prefix, most):
        page = self.s3.list_objects_v2(Bucket=self.name, Prefix=prefix, MaxKeys=most)
        return [item["Key"] for item in page.get("Contents", [])]

    def get(self, key):
        return self.s3.get_object(Bucket=self.name, Key=key)["Body"].read().decode("utf-8")

    def put(self, key, body):
        self.s3.put_object(Bucket=self.name, Key=key, Body=body.encode(), ContentType="application/json")


# The bucket, made at the first call and kept for the calls after.
_bucket = None


def entries():
    global _bucket
    if _bucket is None:
        name = os.environ.get("ENTRIES_BUCKET")
        if not name:
            raise RuntimeError("ENTRIES_BUCKET is not set: template.yaml sets it to the bucket it makes")
        _bucket = Bucket(name)
    return _bucket

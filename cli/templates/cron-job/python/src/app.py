# {{name}}'s job, run each morning at 06:00 UTC by its schedule: the report of the day before, from the files that
# arrived in its bucket under incoming/ that day, written beside them as reports/<day>.json.
# The event is EventBridge's Scheduled Event, the same on FF and on AWS Lambda. The day reported is the one before
# its time, so that a run made again, from the queue of failed runs, reports the same day; a run by hand may name it,
# {"day": "2026-11-09"}. A run that raises is tried twice more, then its event goes to that queue, as template.yaml
# says. BUCKET names the bucket; boto3 finds its endpoint and its key in the function's environment, on FF as on AWS.
import json
import os
import re
from datetime import date, datetime, timedelta, timezone

DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def report(event, bucket):
    """The report of the event's day, written to the bucket, and given back."""
    day = day_of(event)
    arrived = [file for file in bucket.list("incoming/") if file["lastModified"].startswith(day)]
    largest = max(arrived, key=lambda file: file["size"], default=None)
    summary = {
        "day": day,
        "files": len(arrived),
        "bytes": sum(file["size"] for file in arrived),
        "largest": largest and {"key": largest["key"], "size": largest["size"]},
    }
    bucket.put(f"reports/{day}.json", json.dumps(summary, indent=2) + "\n")
    print(f"reported {day}: {summary['files']} files, {summary['bytes']} bytes")
    return summary


def handler(event, context):
    return report(event, files())


def day_of(event):
    """The day the event names, else the one before its time, else yesterday: YYYY-MM-DD, in UTC."""
    if "day" in event:
        day = event["day"]
        if not isinstance(day, str) or not DAY.fullmatch(day) or not valid(day):
            raise ValueError(f"The day to report is YYYY-MM-DD, not {json.dumps(day)}")
        return day
    try:
        at = datetime.fromisoformat(event["time"]) if "time" in event else datetime.now(timezone.utc)
    except (TypeError, ValueError):
        raise ValueError(f"The event's time is no date: {json.dumps(event['time'])}")
    return (at.astimezone(timezone.utc) - timedelta(days=1)).date().isoformat()


def valid(day):
    try:
        date.fromisoformat(day)
        return True
    except ValueError:
        return False


class Bucket:
    """The bucket, through boto3: its files under a prefix, and a file written."""

    def __init__(self, name):
        # Loaded here, so that the tests run without it installed.
        import boto3

        self.name = name
        self.s3 = boto3.client("s3")

    def list(self, prefix):
        found = []
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.name, Prefix=prefix):
            for item in page.get("Contents", []):
                at = item["LastModified"].astimezone(timezone.utc).isoformat(timespec="milliseconds")
                found.append({"key": item["Key"], "size": item["Size"], "lastModified": at.replace("+00:00", "Z")})
        return found

    def put(self, key, body):
        self.s3.put_object(Bucket=self.name, Key=key, Body=body.encode(), ContentType="application/json")


# The bucket, made at the first call and kept for the calls after.
_bucket = None


def files():
    global _bucket
    if _bucket is None:
        name = os.environ.get("BUCKET")
        if not name:
            raise RuntimeError("BUCKET is not set: template.yaml sets it to the bucket it makes")
        _bucket = Bucket(name)
    return _bucket

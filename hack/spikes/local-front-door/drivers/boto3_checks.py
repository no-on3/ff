#!/usr/bin/env python3
# boto3, with its defaults, against one side's front doors: the spike's twelve checks, the same as sdk.mjs's and
# cli.sh's. One JSON line per check, {client, check, passed, detail}.
#   S3_ENDPOINT=… SQS_ENDPOINT=… ACCOUNT=… KEY=… SECRET=… BUCKET=… QUEUE=… python boto3_checks.py
import hashlib
import json
import os
import threading
import time

import boto3
from botocore.config import Config

env = os.environ
s3_endpoint, sqs_endpoint, account, bucket, queue = env["S3_ENDPOINT"], env["SQS_ENDPOINT"], env["ACCOUNT"], env["BUCKET"], env["QUEUE"]
prefix = "boto3/"
MB = 1024 * 1024


def client(service, endpoint, secret=env["SECRET"]):
    config = Config(s3={"addressing_style": "path"}) if service == "s3" else None
    return boto3.client(service, endpoint_url=endpoint, region_name="tn-tunis-1", aws_access_key_id=env["KEY"], aws_secret_access_key=secret, config=config)


objects, queues = client("s3", s3_endpoint), client("sqs", sqs_endpoint)


def check(name, run):
    passed, detail = True, ""
    try:
        detail = str(run() or "")
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        passed = False
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        detail = f"{type(error).__name__}{f' ({code})' if code else ''}: {error}"
    print(json.dumps({"client": "boto3", "check": name, "passed": passed, "detail": detail[:200]}, ensure_ascii=False), flush=True)


def expect(actual, wanted):
    if actual != wanted:
        raise AssertionError(f"got {actual!r}, not {wanted!r}")
    return repr(actual)[:120]


def refused_as(code, run):
    try:
        run()
    except Exception as error:  # noqa: BLE001 - the refusal is what is checked
        return expect(getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__), code)
    raise AssertionError(f"accepted, not refused {code}")


def put_and_get():
    objects.put_object(Bucket=bucket, Key=f"{prefix}hello é.txt", Body=b"Ahlan", ContentType="text/plain", Metadata={"owner": "me"})
    got = objects.get_object(Bucket=bucket, Key=f"{prefix}hello é.txt")
    return expect([got["Body"].read(), got["ContentType"], got["Metadata"]], [b"Ahlan", "text/plain", {"owner": "me"}])


def big():
    data = bytes([7]) * (5 * MB)
    objects.put_object(Bucket=bucket, Key=f"{prefix}big.bin", Body=data)
    got = objects.get_object(Bucket=bucket, Key=f"{prefix}big.bin")["Body"].read()
    return expect(hashlib.sha256(got).hexdigest(), hashlib.sha256(data).hexdigest())


def listed():
    for key in ["a/1", "a/2", "b", "c"]:
        objects.put_object(Bucket=bucket, Key=f"{prefix}list/{key}", Body=key.encode())
    grouped = objects.list_objects_v2(Bucket=bucket, Prefix=f"{prefix}list/", Delimiter="/")
    expect(
        [[common["Prefix"] for common in grouped.get("CommonPrefixes", [])], [item["Key"] for item in grouped.get("Contents", [])]],
        [[f"{prefix}list/a/"], [f"{prefix}list/b", f"{prefix}list/c"]],
    )
    keys, token = [], None
    while True:
        page = objects.list_objects_v2(Bucket=bucket, Prefix=f"{prefix}list/", MaxKeys=3, **({"ContinuationToken": token} if token else {}))
        keys += [item["Key"][len(prefix) + 5 :] for item in page.get("Contents", [])]
        token = page.get("NextContinuationToken")
        if not token:
            return expect(keys, ["a/1", "a/2", "b", "c"])


check("put and get, with its type and metadata", put_and_get)
check("put 5 MB as a stream, aws-chunked with a trailing checksum, and get the same bytes", big)
check("get a range", lambda: expect(objects.get_object(Bucket=bucket, Key=f"{prefix}hello é.txt", Range="bytes=0-2")["Body"].read(), b"Ahl"))
check("list by a prefix and a delimiter, then page by page", listed)
check("a missing key: NoSuchKey", lambda: refused_as("NoSuchKey", lambda: objects.get_object(Bucket=bucket, Key=f"{prefix}nothing")))
check(
    "S3 with a wrong secret: SignatureDoesNotMatch",
    lambda: refused_as("SignatureDoesNotMatch", lambda: client("s3", s3_endpoint, "wrong-secret").get_object(Bucket=bucket, Key=f"{prefix}hello é.txt")),
)

state = {"url": "", "handle": ""}


def queue_url():
    state["url"] = queues.get_queue_url(QueueName=queue)["QueueUrl"]
    return expect(state["url"], f"{sqs_endpoint}/{account}/{queue}")


def send_and_receive():
    attributes = {
        "city": {"DataType": "String", "StringValue": "تونس"},
        "count": {"DataType": "Number", "StringValue": "12"},
        "raw": {"DataType": "Binary", "BinaryValue": bytes([0, 1, 2, 255])},
    }
    queues.send_message(QueueUrl=state["url"], MessageBody="مرحبا", MessageAttributes=attributes)
    messages = queues.receive_message(QueueUrl=state["url"], MessageAttributeNames=["All"], MessageSystemAttributeNames=["All"], WaitTimeSeconds=1).get("Messages", [])
    message = messages[0] if messages else {}
    state["handle"] = message.get("ReceiptHandle", "")
    got = message.get("MessageAttributes", {})
    return expect(
        [message.get("Body"), got.get("city", {}).get("StringValue"), got.get("count", {}).get("StringValue"), got.get("raw", {}).get("BinaryValue", b"").hex(), message.get("Attributes", {}).get("ApproximateReceiveCount")],
        ["مرحبا", "تونس", "12", "000102ff", "1"],
    )


def delete_then_empty():
    queues.delete_message(QueueUrl=state["url"], ReceiptHandle=state["handle"])
    started = time.monotonic()
    answer = queues.receive_message(QueueUrl=state["url"], WaitTimeSeconds=1)
    return expect([len(answer.get("Messages", [])), time.monotonic() - started >= 0.9], [0, True])


def long_poll_ended():
    started, answer = time.monotonic(), {}
    polling = threading.Thread(target=lambda: answer.update(queues.receive_message(QueueUrl=state["url"], WaitTimeSeconds=10)))
    polling.start()
    time.sleep(0.3)
    client("sqs", sqs_endpoint).send_message(QueueUrl=state["url"], MessageBody="during")
    polling.join()
    messages = answer.get("Messages", [])
    if messages:
        queues.delete_message(QueueUrl=state["url"], ReceiptHandle=messages[0]["ReceiptHandle"])
    return expect([messages[0]["Body"] if messages else None, time.monotonic() - started < 3], ["during", True])


check("GetQueueUrl: the queue's URL under the endpoint and the account", queue_url)
check("send with attributes of each type and Arabic text; receive them back, the SDK checking the MD5 sums", send_and_receive)
check("delete it, then an empty queue answers after its wait", delete_then_empty)
check("a message sent during a long poll ends it at once", long_poll_ended)
check("a queue that is not there: QueueDoesNotExist", lambda: refused_as("AWS.SimpleQueueService.NonExistentQueue", lambda: queues.get_queue_url(QueueName="nowhere")))
check("SQS with a wrong secret: SignatureDoesNotMatch", lambda: refused_as("SignatureDoesNotMatch", lambda: client("sqs", sqs_endpoint, "wrong-secret").get_queue_url(QueueName=queue)))

#!/usr/bin/env python3
"""boto3 against the spike's SQS endpoint, with its defaults, as a customer's code has them: only the endpoint, the
region and the key are given. One JSON line per check, as sqs.sh reads them.
  ENDPOINT=http://127.0.0.1:<port> KEY=... SECRET=... python sqs_boto3_check.py
"""
import json
import os
import threading
import time

import boto3

ENDPOINT, KEY, SECRET = os.environ["ENDPOINT"], os.environ["KEY"], os.environ["SECRET"]


def client(key=KEY, secret=SECRET):
    return boto3.client("sqs", endpoint_url=ENDPOINT, region_name="tn-tunis-1", aws_access_key_id=key, aws_secret_access_key=secret)


sqs = client()


def check(want, what, run):
    got, detail = "ok", ""
    try:
        detail = str(run() or "")
    except Exception as error:  # botocore's ClientError, and whatever a check of its own raises
        got = "refused"
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        detail = f"{type(error).__name__}{f' ({code})' if code else ''}: {error}"[:200]
    print(json.dumps({"client": "boto3", "want": want, "got": got, "what": what, "detail": detail}), flush=True)


def expect(got, wanted, what="value"):
    if got != wanted:
        raise AssertionError(f"{what}: wanted {wanted!r}, got {got!r}")
    return repr(got)[:120]


url = None


def create():
    global url
    url = sqs.create_queue(QueueName="boto3-orders")["QueueUrl"]
    return expect(url, f"{ENDPOINT}/000000000001/boto3-orders", "QueueUrl")


check("ok", "CreateQueue answers its URL, under the endpoint and the account", create)
check("ok", "GetQueueUrl, ListQueues", lambda: (expect(sqs.get_queue_url(QueueName="boto3-orders")["QueueUrl"], url), expect(sqs.list_queues(QueueNamePrefix="boto3-")["QueueUrls"], [url]))[1])
attributes = {
    "kind": {"DataType": "String", "StringValue": "order"},
    "quantity": {"DataType": "Number", "StringValue": "2"},
    "raw": {"DataType": "Binary", "BinaryValue": bytes([0, 1, 2, 255])},
}
check("ok", "SendMessage with attributes of each type, its MD5 sums checked by boto3", lambda: sqs.send_message(QueueUrl=url, MessageBody='{"item":"harissa"} é', MessageAttributes=attributes)["MessageId"])


def receive():
    messages = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10, WaitTimeSeconds=1, MessageAttributeNames=["All"]).get("Messages", [])
    expect(len(messages), 1, "messages")
    expect(messages[0]["Body"], '{"item":"harissa"} é', "Body")
    expect(messages[0]["MessageAttributes"]["raw"]["BinaryValue"], bytes([0, 1, 2, 255]), "binary attribute")
    sqs.delete_message(QueueUrl=url, ReceiptHandle=messages[0]["ReceiptHandle"])
    return messages[0]["MessageId"] + ", deleted"


check("ok", "ReceiveMessage gives it back, body and attributes as sent, its MD5 sums checked", receive)


def empty_wait():
    started = time.monotonic()
    messages = sqs.receive_message(QueueUrl=url, WaitTimeSeconds=2).get("Messages", [])
    waited = time.monotonic() - started
    if messages or not 1.8 <= waited <= 3.5:
        raise AssertionError(f"{len(messages)} messages after {waited:.2f} s")
    return f"{waited:.2f} s"


check("ok", "long polling: an empty queue answers after its wait, about 2 s", empty_wait)


def woken():
    started = time.monotonic()
    threading.Timer(0.5, lambda: client().send_message(QueueUrl=url, MessageBody="during the wait")).start()
    messages = sqs.receive_message(QueueUrl=url, WaitTimeSeconds=10).get("Messages", [])
    waited = time.monotonic() - started
    expect([m["Body"] for m in messages], ["during the wait"], "bodies")
    if waited > 2.5:
        raise AssertionError(f"answered after {waited:.2f} s")
    sqs.delete_message(QueueUrl=url, ReceiptHandle=messages[0]["ReceiptHandle"])
    return f"{waited:.2f} s"


check("ok", "long polling: a message sent during the wait ends it at once", woken)


def batches():
    sent = sqs.send_message_batch(QueueUrl=url, Entries=[{"Id": f"m{n}", "MessageBody": f"batch {n}"} for n in range(10)])
    expect(len(sent["Successful"]), 10, "sent")
    messages = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10).get("Messages", [])
    expect(len(messages), 10, "received")
    deleted = sqs.delete_message_batch(QueueUrl=url, Entries=[{"Id": f"d{n}", "ReceiptHandle": m["ReceiptHandle"]} for n, m in enumerate(messages)])
    return expect((len(deleted["Successful"]), len(deleted.get("Failed", []))), (10, 0), "deleted, failed")


check("ok", "SendMessageBatch of 10, ReceiveMessage of 10, DeleteMessageBatch of 10", batches)
check("refused", "GetQueueUrl of a queue that is not there: QueueDoesNotExist", lambda: sqs.get_queue_url(QueueName="nowhere"))
check("refused", "a wrong secret: SignatureDoesNotMatch", lambda: client(secret="wrong").list_queues())
check("refused", "an unknown key: InvalidClientTokenId", lambda: client(key="AKFFUNKNOWNUNKNOWN22").list_queues())
wrong = sqs.create_queue(QueueName="wrong-md5")["QueueUrl"]
check("refused", "SendMessage answered with a wrong MD5 sum: boto3 says so", lambda: sqs.send_message(QueueUrl=wrong, MessageBody="checked"))
check("refused", "ReceiveMessage answered with a wrong MD5 sum: boto3 says so", lambda: sqs.receive_message(QueueUrl=wrong, WaitTimeSeconds=1))
check("ok", "PurgeQueue, DeleteQueue", lambda: (sqs.purge_queue(QueueUrl=wrong), sqs.delete_queue(QueueUrl=wrong), sqs.delete_queue(QueueUrl=url), expect(sqs.list_queues().get("QueueUrls", []), [], "QueueUrls"))[-1])

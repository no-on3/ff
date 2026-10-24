#!/usr/bin/env python3
# boto3 against FF's SQS endpoint, with its defaults, as a customer's code has them: only the endpoint, the region and
# the key are given. One JSON line per check, {client, want, got, what}, for hack/e2e.sh.
#   ENDPOINT=http://localhost:<port> ACCOUNT=<12 digits> KEY=… SECRET=… OTHER_URL=<a queue of another account's> \
#   python boto3_checks.py
import json
import os
import threading
import time

import boto3

endpoint, account, other_url = os.environ["ENDPOINT"], os.environ["ACCOUNT"], os.environ["OTHER_URL"]


def client(key=os.environ["KEY"], secret=os.environ["SECRET"]):
    return boto3.client("sqs", endpoint_url=endpoint, region_name="tn-tunis-1", aws_access_key_id=key, aws_secret_access_key=secret)


sqs = client()


def check(want, what, run):
    got, detail = "ok", ""
    try:
        detail = str(run() or "")
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        got = "refused"
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        detail = f"{type(error).__name__}{f' ({code})' if code else ''}: {error}"
    print(json.dumps({"client": "boto3", "want": want, "got": got, "what": what, "detail": detail[:200]}), flush=True)


def expect(actual, wanted):
    if actual != wanted:
        raise AssertionError(f"got {actual!r}, not {wanted!r}")
    return repr(actual)[:120]


def refused_as(run, code):
    """Refused, its code as boto3 reads it, the query protocol's from the x-amzn-query-error header."""
    try:
        run()
    except Exception as error:  # noqa: BLE001 - the refusal is the result
        return expect(getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__), code)
    raise AssertionError("accepted")


url = sqs.create_queue(QueueName="e2e-boto3-orders")["QueueUrl"]
check("ok", "CreateQueue answers its URL, under the endpoint and the account; GetQueueUrl finds it", lambda: (
    expect(url, f"{endpoint}/{account}/e2e-boto3-orders"), expect(sqs.get_queue_url(QueueName="e2e-boto3-orders")["QueueUrl"], url))[-1])
attributes = {
    "item": {"DataType": "String", "StringValue": "harissa"},
    "quantity": {"DataType": "Number", "StringValue": "2"},
    "label": {"DataType": "Binary", "BinaryValue": bytes([0, 1, 2, 255])},
}


def sent_and_received():
    sent = sqs.send_message(QueueUrl=url, MessageBody='{"order": 8} é', MessageAttributes=attributes)
    messages = sqs.receive_message(QueueUrl=url, WaitTimeSeconds=2, MessageAttributeNames=["All"]).get("Messages", [])
    expect([(m["MessageId"], m["Body"]) for m in messages], [(sent["MessageId"], '{"order": 8} é')])
    expect({name: value.get("StringValue", value.get("BinaryValue")) for name, value in messages[0]["MessageAttributes"].items()},
           {"item": "harissa", "quantity": "2", "label": bytes([0, 1, 2, 255])})
    sqs.delete_message(QueueUrl=url, ReceiptHandle=messages[0]["ReceiptHandle"])
    return expect(messages[0]["MD5OfMessageAttributes"], sent["MD5OfMessageAttributes"])


check("ok", "SendMessage with attributes of each type; ReceiveMessage gives them back, and the same MD5 sum", sent_and_received)


def woken():
    started = time.monotonic()
    threading.Timer(0.5, lambda: client().send_message(QueueUrl=url, MessageBody="during the wait")).start()
    messages = sqs.receive_message(QueueUrl=url, WaitTimeSeconds=10).get("Messages", [])
    waited = time.monotonic() - started
    expect([m["Body"] for m in messages], ["during the wait"])
    if waited > 2:
        raise AssertionError(f"answered after {waited:.2f} s")
    sqs.delete_message(QueueUrl=url, ReceiptHandle=messages[0]["ReceiptHandle"])
    return f"{waited:.2f} s"


check("ok", "a long poll: a message sent during the wait ends it at once", woken)


def batches():
    sent = sqs.send_message_batch(QueueUrl=url, Entries=[{"Id": f"m{n}", "MessageBody": f"batch {n}"} for n in range(10)])
    messages = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10).get("Messages", [])
    deleted = sqs.delete_message_batch(QueueUrl=url, Entries=[{"Id": f"d{n}", "ReceiptHandle": m["ReceiptHandle"]} for n, m in enumerate(messages)])
    return expect((len(sent["Successful"]), len(messages), len(deleted["Successful"]), len(deleted.get("Failed", []))), (10, 10, 10, 0))


check("ok", "SendMessageBatch of 10, ReceiveMessage of 10, DeleteMessageBatch of 10", batches)
check("ok", "a queue that is not there: its query code, AWS.SimpleQueueService.NonExistentQueue",
      lambda: refused_as(lambda: sqs.get_queue_url(QueueName="nowhere"), "AWS.SimpleQueueService.NonExistentQueue"))
check("ok", "another account's queue, by its URL: one that doesn't exist",
      lambda: refused_as(lambda: sqs.send_message(QueueUrl=other_url, MessageBody="not mine"), "AWS.SimpleQueueService.NonExistentQueue"))
check("ok", "a wrong secret: SignatureDoesNotMatch", lambda: refused_as(lambda: client(secret="wrong-secret").list_queues(), "SignatureDoesNotMatch"))
check("ok", "PurgeQueue, then DeleteQueue", lambda: (sqs.purge_queue(QueueUrl=url), sqs.delete_queue(QueueUrl=url),
                                                       expect(sqs.list_queues(QueueNamePrefix="e2e-boto3-").get("QueueUrls", []), []))[-1])

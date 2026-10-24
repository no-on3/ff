# A function as it would run on AWS Lambda with its role: boto3 with no setting at all. FF gives its pods a key of the
# function's own, the region and the SQS endpoint in their environment, which boto3 reads.
import boto3
from botocore.exceptions import ClientError

sqs = boto3.client("sqs")


def handler(event, context):
    # A queue's URL from outside, as the console and ff show it: boto3 sends every request to its endpoint, FF's
    # inside the cluster, whatever the URL's host.
    url = event["publicUrl"]
    sqs.send_message(QueueUrl=url, MessageBody="sent by a Python function")
    received = sqs.receive_message(QueueUrl=url, MaxNumberOfMessages=10, WaitTimeSeconds=5).get("Messages", [])
    for message in received:
        sqs.delete_message(QueueUrl=url, ReceiptHandle=message["ReceiptHandle"])
    try:
        sqs.get_queue_url(QueueName="nowhere")
        other = "reached"
    except ClientError as error:
        other = error.response["Error"]["Code"]
    return {"bodies": sorted(message["Body"] for message in received), "other": other}

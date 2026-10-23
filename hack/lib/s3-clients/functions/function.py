# A function as it would run on AWS Lambda with its role: boto3 with no setting at all. FF gives its pods a key of the
# function's own, the region and the S3 endpoint in their environment, which boto3 reads.
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")


def handler(event, context):
    s3.put_object(Bucket=event["bucket"], Key="from-python.txt", Body=b"written by a Python function")
    read = s3.get_object(Bucket=event["bucket"], Key="from-python.txt")["Body"].read().decode()
    try:
        s3.get_object(Bucket=event["other"], Key="anything.txt")
        other = "reached"
    except ClientError as error:
        other = error.response["Error"]["Code"]
    return {"read": read, "other": other}

# {{name}}'s uploads: S3's event, a record for each new file of the bucket.
from urllib.parse import unquote_plus


def handler(event, context):
    for record in event["Records"]:
        key = unquote_plus(record["s3"]["object"]["key"])
        print(f"new file {key} in {record['s3']['bucket']['name']}, {record['s3']['object'].get('size', 0)} bytes")

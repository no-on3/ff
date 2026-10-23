#!/usr/bin/env python3
# boto3 against the spike's S3 front door, with its defaults, as a customer's code has them: only the endpoint, the
# region and the key are given. Prints one JSON line per check.
#   ENDPOINT=http://s3.localhost:55480 KEY=… SECRET=… BUCKET=photos OTHER_BUCKET=other python boto3_check.py
import io
import json
import os
import time
import urllib.request

import boto3
from botocore.config import Config

endpoint = os.environ["ENDPOINT"]
bucket = os.environ["BUCKET"]
other = os.environ["OTHER_BUCKET"]
session = boto3.session.Session(aws_access_key_id=os.environ["KEY"], aws_secret_access_key=os.environ["SECRET"], region_name="tn-tunis-1")
s3 = session.client("s3", endpoint_url=endpoint)
virtual = session.client("s3", endpoint_url=endpoint, config=Config(s3={"addressing_style": "virtual"}))
MB = 1024 * 1024


def check(want, what, run):
    got, detail = "ok", ""
    try:
        detail = str(run() or "")
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        got, detail = "refused", f"{type(error).__name__}: {error}"[:160]
    print(json.dumps({"client": "boto3", "want": want, "got": got, "what": what, "detail": detail}), flush=True)


def fetch(url, method="GET", data=None, headers=None):
    request = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    with urllib.request.urlopen(request) as answer:
        return answer.read().decode()


check("ok", "put_object, bytes (boto3's default addressing for a custom endpoint)", lambda: s3.put_object(Bucket=bucket, Key="boto/hello.txt", Body=b"hello from boto3")["ETag"])
check("ok", "put_object, virtual-hosted asked for", lambda: virtual.put_object(Bucket=bucket, Key="boto/virtual.txt", Body=b"virtual")["ETag"])
check("ok", "get_object", lambda: s3.get_object(Bucket=bucket, Key="boto/hello.txt")["Body"].read().decode())
check("ok", "get_object with a Range", lambda: s3.get_object(Bucket=bucket, Key="boto/hello.txt", Range="bytes=6-9")["Body"].read().decode())
check("ok", "head_object", lambda: s3.head_object(Bucket=bucket, Key="boto/hello.txt")["ContentLength"])
check("ok", "upload_fileobj: 20 MB, multipart by s3transfer", lambda: s3.upload_fileobj(io.BytesIO(b"\x05" * (20 * MB)), bucket, "boto/big.bin") or s3.head_object(Bucket=bucket, Key="boto/big.bin")["ContentLength"])
check("ok", "download_fileobj of it, in ranges", lambda: (lambda buffer: (s3.download_fileobj(bucket, "boto/big.bin", buffer), len(buffer.getvalue()))[1])(io.BytesIO()))
check("ok", "list_objects_v2 with a prefix", lambda: ", ".join(o["Key"] for o in s3.list_objects_v2(Bucket=bucket, Prefix="boto/").get("Contents", [])))
check("ok", "copy_object", lambda: s3.copy_object(Bucket=bucket, Key="boto/copy.txt", CopySource={"Bucket": bucket, "Key": "boto/hello.txt"})["CopyObjectResult"]["ETag"])
check("ok", "a presigned GET URL, fetched", lambda: fetch(s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": "boto/hello.txt"}, ExpiresIn=300)))
check("ok", "a presigned PUT URL, then read back", lambda: (fetch(s3.generate_presigned_url("put_object", Params={"Bucket": bucket, "Key": "boto/presigned.txt"}, ExpiresIn=300), "PUT", b"presigned by boto3"), s3.get_object(Bucket=bucket, Key="boto/presigned.txt")["Body"].read().decode())[1])


def expired():
    url = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": "boto/hello.txt"}, ExpiresIn=1)
    time.sleep(2.1)
    return fetch(url)


check("refused", "a presigned URL past its expiry", expired)
check("refused", "a bucket the key may not reach", lambda: s3.get_object(Bucket=other, Key="secret.txt"))
check("ok", "delete_objects", lambda: len(s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": "boto/copy.txt"}, {"Key": "boto/virtual.txt"}]}).get("Deleted", [])))
check("ok", "list_buckets", lambda: ", ".join(b["Name"] for b in s3.list_buckets()["Buckets"]))

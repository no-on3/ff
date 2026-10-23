#!/usr/bin/env python3
# boto3 against FF's S3 front door, with its defaults, as a customer's code has them: only the endpoint, the region
# and the key are given. One JSON line per check, {client, want, got, what}, for hack/e2e.sh.
#   ENDPOINT=http://s3.localhost:<port> KEY=… SECRET=… BUCKET=… OTHER_BUCKET=… BIG=<a file of 100 MB> python boto3_checks.py
import hashlib
import io
import json
import os
import time
import urllib.error
import urllib.request

import boto3
from botocore.config import Config

endpoint = os.environ["ENDPOINT"]
bucket = os.environ["BUCKET"]
other = os.environ["OTHER_BUCKET"]
big = os.environ["BIG"]
session = boto3.session.Session(aws_access_key_id=os.environ["KEY"], aws_secret_access_key=os.environ["SECRET"], region_name="tn-tunis-1")
# boto3 addresses a custom endpoint path-style by default; virtual-hosted when asked.
s3 = session.client("s3", endpoint_url=endpoint)
virtual = session.client("s3", endpoint_url=endpoint, config=Config(s3={"addressing_style": "virtual"}))


def check(want, what, run):
    got, detail = "ok", ""
    try:
        detail = str(run() or "")
    except Exception as error:  # noqa: BLE001 - every failure is a result here
        got, detail = "refused", f"{type(error).__name__}: {error}"
    print(json.dumps({"client": "boto3", "want": want, "got": got, "what": what, "detail": detail[:200]}), flush=True)


def same(actual, wanted):
    if actual != wanted:
        raise AssertionError(f"got {actual!r}, not {wanted!r}")
    return actual


def fetch(url, method="GET", data=None):
    request = urllib.request.Request(url, method=method, data=data)
    with urllib.request.urlopen(request) as answer:
        return answer.read().decode()


def sha256_of(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1 << 20), b""):
        digest.update(chunk)
    return digest.hexdigest()


def big_upload():
    s3.upload_file(big, bucket, "boto/big.bin")
    downloaded = io.BytesIO()
    s3.download_fileobj(bucket, "boto/big.bin", downloaded)
    downloaded.seek(0)
    with open(big, "rb") as local:
        return same(f"{len(downloaded.getvalue())} {sha256_of(downloaded)}", f"{os.path.getsize(big)} {sha256_of(local)}")


def expired():
    url = s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": "boto/hello.txt"}, ExpiresIn=1)
    time.sleep(2.1)
    return fetch(url)


check("ok", "uploads bytes, path-style, and downloads them", lambda: (s3.put_object(Bucket=bucket, Key="boto/hello.txt", Body=b"Ahlan from boto3"), same(s3.get_object(Bucket=bucket, Key="boto/hello.txt")["Body"].read(), b"Ahlan from boto3"))[1])
check("ok", "uploads and downloads virtual-hosted, when asked", lambda: (virtual.put_object(Bucket=bucket, Key="boto/virtual.txt", Body=b"virtual"), same(virtual.get_object(Bucket=bucket, Key="boto/virtual.txt")["Body"].read(), b"virtual"))[1])
check("ok", "downloads a range", lambda: same(s3.get_object(Bucket=bucket, Key="boto/hello.txt", Range="bytes=0-4")["Body"].read(), b"Ahlan"))
check("ok", "uploads 100 MB in parts with s3transfer, and downloads it in ranges, its bytes the same", big_upload)
check("ok", "lists by a prefix", lambda: same(sorted(o["Key"] for o in s3.list_objects_v2(Bucket=bucket, Prefix="boto/")["Contents"]), ["boto/big.bin", "boto/hello.txt", "boto/virtual.txt"]))
check("ok", "a presigned GET, fetched", lambda: same(fetch(s3.generate_presigned_url("get_object", Params={"Bucket": bucket, "Key": "boto/hello.txt"}, ExpiresIn=300)), "Ahlan from boto3"))
check("ok", "a presigned PUT, then read back", lambda: (fetch(s3.generate_presigned_url("put_object", Params={"Bucket": bucket, "Key": "boto/presigned.txt"}, ExpiresIn=300), "PUT", b"presigned by boto3"), same(s3.get_object(Bucket=bucket, Key="boto/presigned.txt")["Body"].read(), b"presigned by boto3"))[1])
check("refused", "a presigned URL past its expiry: AccessDenied", expired)
check("refused", "a wrong secret: SignatureDoesNotMatch", lambda: boto3.session.Session(aws_access_key_id=os.environ["KEY"], aws_secret_access_key=os.environ["SECRET"] + "x", region_name="tn-tunis-1").client("s3", endpoint_url=endpoint).head_object(Bucket=bucket, Key="boto/hello.txt"))
check("refused", "another account's bucket: AccessDenied", lambda: s3.get_object(Bucket=other, Key="anything.txt"))
check("ok", "copies, then deletes a batch", lambda: (s3.copy_object(Bucket=bucket, Key="boto/copy.txt", CopySource={"Bucket": bucket, "Key": "boto/hello.txt"}), same(len(s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": "boto/copy.txt"}, {"Key": "boto/presigned.txt"}]})["Deleted"]), 2))[1])

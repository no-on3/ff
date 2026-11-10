# {{name}}'s thumbnails: for each image put in its bucket under uploads/, a WebP of SIZE pixels at most each way,
# written under thumbnails/ at the same path, its extension .webp. The event is S3's, as Lambda gets it, the same on
# FF and on AWS; the bucket is the event's. Pillow makes the thumbnail: its wheel's native code is Linux's, which
# ff deploy, ff deploy --container and sam build --use-container install whatever this machine is.
import io
import json
from urllib.parse import unquote_plus

# The thumbnail's most pixels, each way: a smaller image is kept its size.
SIZE = 200
UPLOADS = "uploads/"
THUMBNAILS = "thumbnails/"


def handler(event, context):
    return thumbnails(event, bucket(), resize)


def thumbnails(event, bucket, resize):
    """The thumbnails of the event's uploads, each written beside its image: `bucket` reads and writes the files,
    `resize` makes a thumbnail of an image's bytes. The tests give their own."""
    made = []
    for record in event.get("Records", []):
        name = record["s3"]["bucket"]["name"]
        key = key_of(record)
        thumbnail = thumbnail_of(key)
        if thumbnail is None:
            print(json.dumps({"left": key, "why": f"not a file under {UPLOADS}"}, ensure_ascii=False))
            continue
        image = bucket.get(name, key)
        try:
            small = resize(image)
        except Exception as error:
            # A file that is no image, or one too damaged to read: trying again would fail again.
            print(json.dumps({"left": key, "why": str(error)}, ensure_ascii=False))
            continue
        bucket.put(name, thumbnail, small, "image/webp")
        print(json.dumps({"made": thumbnail, "from": key, "bytes": len(small)}, ensure_ascii=False))
        made.append(thumbnail)
    return {"made": made}


def key_of(record):
    """The record's key as it was put: S3 writes it in an event as a URL's query writes it, a space a "+"."""
    return unquote_plus(record["s3"]["object"]["key"])


def thumbnail_of(key):
    """The thumbnail's key of a file under uploads/, its extension .webp; None for another key."""
    if not key.startswith(UPLOADS) or key.endswith("/"):
        return None
    path = key[len(UPLOADS) :]
    dot = path.rfind(".")
    stem = path[:dot] if dot > path.rfind("/") + 1 else path
    return f"{THUMBNAILS}{stem}.webp"


def resize(image):
    # Loaded here, so that the tests run without it installed.
    from PIL import Image, ImageOps

    with Image.open(io.BytesIO(image)) as opened:
        # Turned as the camera says it was held, then made smaller, never larger.
        small = ImageOps.exif_transpose(opened)
        small.thumbnail((SIZE, SIZE))
        written = io.BytesIO()
        small.save(written, "WEBP")
    return written.getvalue()


class Bucket:
    """The event's buckets, through boto3: a file read, a file written."""

    def __init__(self):
        import boto3

        self.s3 = boto3.client("s3")

    def get(self, name, key):
        return self.s3.get_object(Bucket=name, Key=key)["Body"].read()

    def put(self, name, key, body, content_type):
        self.s3.put_object(Bucket=name, Key=key, Body=body, ContentType=content_type)


# The client, made at the first call and kept for the calls after.
_bucket = None


def bucket():
    global _bucket
    if _bucket is None:
        _bucket = Bucket()
    return _bucket

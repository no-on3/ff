# The thumbnails, outside the CodeUri so that no package holds them: python3 -m unittest, from the application's
# folder. The bucket is a stand-in that keeps its files in a dict, and the resize one that marks the bytes it is
# given, so that the tests need neither the bucket nor Pillow.
import io
import json
import pathlib
import unittest
from contextlib import redirect_stdout

from src import app

EVENTS = pathlib.Path(__file__).parents[1] / "events"


def upload():
    return json.loads((EVENTS / "upload.json").read_text())


def record(bucket, key):
    return {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}


class StandIn:
    def __init__(self, files):
        self.files = files
        self.read = []
        self.written = {}

    def get(self, name, key):
        self.read.append(f"{name}/{key}")
        return self.files[f"{name}/{key}"]

    def put(self, name, key, body, content_type):
        self.written[f"{name}/{key}"] = (body, content_type)


def resize(image):
    if not image.startswith(b"image:"):
        raise OSError("cannot identify image file")
    return b"small " + image


def thumbnails(event, bucket):
    with redirect_stdout(io.StringIO()):
        return app.thumbnails(event, bucket, resize)


class Thumbnails(unittest.TestCase):
    def test_an_upload_makes_its_thumbnail_in_the_event_s_bucket_under_thumbnails_its_key_read_as_put(self):
        event = upload()
        name = event["Records"][0]["s3"]["bucket"]["name"]
        bucket = StandIn({f"{name}/uploads/Sidi Bou Saïd.jpg": b"image:sea"})

        made = thumbnails(event, bucket)

        self.assertEqual(made, {"made": ["thumbnails/Sidi Bou Saïd.webp"]})
        self.assertEqual(bucket.read, [f"{name}/uploads/Sidi Bou Saïd.jpg"])
        self.assertEqual(bucket.written, {f"{name}/thumbnails/Sidi Bou Saïd.webp": (b"small image:sea", "image/webp")})

    def test_each_record_of_the_event_is_made_in_its_order(self):
        bucket = StandIn({"b/uploads/a.png": b"image:a", "b/uploads/2026/b.gif": b"image:b"})

        made = thumbnails({"Records": [record("b", "uploads/a.png"), record("b", "uploads/2026/b.gif")]}, bucket)

        self.assertEqual(made["made"], ["thumbnails/a.webp", "thumbnails/2026/b.webp"])
        self.assertEqual(list(bucket.written), ["b/thumbnails/a.webp", "b/thumbnails/2026/b.webp"])

    def test_a_file_that_is_no_image_is_left_nothing_written_and_no_error(self):
        bucket = StandIn({"b/uploads/notes.txt": b"notes"})

        self.assertEqual(thumbnails({"Records": [record("b", "uploads/notes.txt")]}, bucket), {"made": []})
        self.assertEqual(bucket.written, {})

    def test_a_key_outside_uploads_a_thumbnail_among_them_is_left_unread(self):
        bucket = StandIn({})
        keys = ["thumbnails/a.webp", "a.png", "uploads/", "uploads/2026/"]

        made = thumbnails({"Records": [record("b", key) for key in keys]}, bucket)

        self.assertEqual([made["made"], bucket.read, bucket.written], [[], [], {}])

    def test_an_error_of_the_bucket_fails_the_call_so_that_it_is_tried_again(self):
        bucket = StandIn({})

        with self.assertRaises(KeyError):
            thumbnails({"Records": [record("b", "uploads/a.png")]}, bucket)


class Keys(unittest.TestCase):
    def test_a_thumbnail_s_key_is_the_upload_s_path_under_thumbnails_its_extension_webp(self):
        keys = {
            "uploads/a.png": "thumbnails/a.webp",
            "uploads/a": "thumbnails/a.webp",
            "uploads/a.tar.gz": "thumbnails/a.tar.webp",
            "uploads/.hidden": "thumbnails/.hidden.webp",
            "uploads/v1.2/a": "thumbnails/v1.2/a.webp",
            "uploads/uploads/a.jpeg": "thumbnails/uploads/a.webp",
        }

        self.assertEqual({key: app.thumbnail_of(key) for key in keys}, keys)


if __name__ == "__main__":
    unittest.main()

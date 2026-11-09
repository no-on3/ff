# The API's routes, outside its CodeUri so that no package holds them: python3 -m unittest, from the application's
# folder. The bucket is a stand-in that keeps its objects in a dict and lists their keys in order, as a bucket does.
import base64
import json
import pathlib
import re
import unittest
from datetime import datetime, timezone

from src import app

EVENTS = pathlib.Path(__file__).parents[1] / "events"


def event(name):
    return json.loads((EVENTS / name).read_text())


def request(method, path, body=None):
    return {"rawPath": path, "requestContext": {"http": {"method": method, "path": path}}, "body": body}


def entry(at, name, message):
    date = datetime.fromisoformat(at.replace("Z", "+00:00"))
    return {"id": app.id_of(date, "cafe0001"), "name": name, "message": message, "at": at}


class StandIn:
    def __init__(self, *entries):
        self.objects = {f"entries/{one['id']}.json": json.dumps(one) for one in entries}
        self.asked = []

    def keys(self, prefix, most):
        self.asked.append(("keys", prefix, most))
        return sorted(key for key in self.objects if key.startswith(prefix))[:most]

    def get(self, key):
        return self.objects[key]

    def put(self, key, body):
        self.objects[key] = body


class Routes(unittest.TestCase):
    def test_get_lists_the_latest_entries_the_newest_first(self):
        older = entry("2026-11-08T18:00:00.000Z", "Youssef", "First!")
        newer = entry("2026-11-09T09:30:00.000Z", "Amira", "Greetings from Sousse")
        bucket = StandIn(older, newer)

        answer = app.route(event("list-entries.json"), bucket)

        self.assertEqual([answer["statusCode"], json.loads(answer["body"])], [200, [newer, older]])
        self.assertEqual(bucket.asked, [("keys", "entries/", app.LATEST)])

    def test_post_keeps_the_entry_trimmed_under_its_id_and_answers_201_with_it(self):
        bucket = StandIn()
        before = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

        answer = app.route(event("post-entry.json"), bucket)

        kept = json.loads(answer["body"])
        self.assertEqual(answer["statusCode"], 201)
        self.assertEqual([kept["name"], kept["message"]], ["Amira", "Lovely page, greetings from Sousse!"])
        self.assertRegex(kept["id"], r"^\d{13}-[0-9a-f]{8}$")
        self.assertGreaterEqual(kept["at"], before)
        self.assertEqual(list(bucket.objects), [f"entries/{kept['id']}.json"])
        self.assertEqual(json.loads(bucket.objects[f"entries/{kept['id']}.json"]), kept)

    def test_a_body_in_base64_is_read_as_the_text_it_holds(self):
        bucket = StandIn()
        body = base64.b64encode('{"name": "  Salma ", "message": "Ahlan 👋"}'.encode()).decode()

        answer = app.route({**request("POST", "/entries", body), "isBase64Encoded": True}, bucket)

        kept = json.loads(answer["body"])
        self.assertEqual([answer["statusCode"], kept["name"], len(bucket.objects)], [201, "Salma", 1])

    def test_an_entry_that_is_no_entry_is_refused_with_400_the_bucket_never_written(self):
        bodies = [
            "not json",
            "[]",
            '{"message": "no name"}',
            '{"name": "Amira", "message": "   "}',
            '{"name": 7, "message": "hi"}',
            json.dumps({"name": "x" * 51, "message": "hi"}),
            json.dumps({"name": "Amira", "message": "👋" * 501}),
        ]
        for body in bodies:
            with self.subTest(body=body):
                bucket = StandIn()
                answer = app.route(request("POST", "/entries", body), bucket)

                self.assertEqual(answer["statusCode"], 400)
                self.assertRegex(json.loads(answer["body"])["message"], r"JSON|object|1 to (50|500) characters")
                self.assertEqual(bucket.objects, {})
        longest = json.dumps({"name": "x" * 50, "message": "👋" * 500})
        self.assertEqual(app.route(request("POST", "/entries", longest), StandIn())["statusCode"], 201)

    def test_another_path_is_404_another_method_405_with_the_methods_it_takes(self):
        missing = app.route(request("GET", "/nowhere"), StandIn())
        deleted = app.route(request("DELETE", "/entries"), StandIn())

        self.assertEqual(
            [missing["statusCode"], json.loads(missing["body"])["message"]], [404, "No route for /nowhere"]
        )
        self.assertEqual([deleted["statusCode"], deleted["headers"]["allow"]], [405, "GET, POST"])


class Ids(unittest.TestCase):
    def test_an_id_sorts_a_later_time_first_its_time_counted_down_in_13_digits(self):
        times = ["2026-11-09T09:30:00.001Z", "2026-11-09T09:30:00.000Z", "2001-01-01T00:00:00.000Z"]
        ids = [app.id_of(datetime.fromisoformat(at.replace("Z", "+00:00")), "00000000") for at in times]

        self.assertEqual(sorted(ids), ids)
        self.assertEqual(ids[2], f"{9_999_999_999_999 - 978_307_200_000}-00000000")
        self.assertTrue(all(re.fullmatch(r"\d{13}-0{8}", one) for one in ids))


if __name__ == "__main__":
    unittest.main()

# The API's routes, outside its CodeUri so that no package holds them: python3 -m unittest, from the application's
# folder. The database is a stand-in that answers each query with the rows it is given, and keeps what it was asked.
import base64
import json
import pathlib
import unittest

from src import app

EVENTS = pathlib.Path(__file__).parents[1] / "events"
ITEM = {"id": 1, "name": "Harissa, 2 jars", "createdAt": "2026-11-09T09:00:00Z"}


def event(name):
    return json.loads((EVENTS / name).read_text())


def request(method, path, body=None):
    return {"rawPath": path, "requestContext": {"http": {"method": method, "path": path}}, "body": body}


class StandIn:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.asked = []

    def query(self, text, values=()):
        self.asked.append((text.split(" ")[0], list(values)))
        return self.answers.pop(0) if self.answers else []

    def connect(self):
        return self


class RoutesTest(unittest.TestCase):
    def test_get_items_lists_the_latest_items(self):
        db = StandIn([ITEM])
        answer = app.route(event("list-items.json"), db.connect)

        self.assertEqual((answer["statusCode"], json.loads(answer["body"])), (200, [ITEM]))
        self.assertEqual(db.asked, [("SELECT", [])])

    def test_post_items_keeps_the_item_and_answers_201_with_it_and_its_address(self):
        db = StandIn([ITEM])
        answer = app.route(event("create-item.json"), db.connect)

        self.assertEqual(
            (answer["statusCode"], answer["headers"]["location"], json.loads(answer["body"])), (201, "/items/1", ITEM)
        )
        self.assertEqual(db.asked, [("INSERT", ["Harissa, 2 jars"])])

    def test_a_body_in_base64_is_read_as_the_text_it_holds(self):
        db = StandIn([ITEM])
        body = base64.b64encode('{"name": "  Harissa, 2 jars "}'.encode()).decode()
        answer = app.route({**request("POST", "/items", body), "isBase64Encoded": True}, db.connect)

        self.assertEqual((answer["statusCode"], db.asked), (201, [("INSERT", ["Harissa, 2 jars"])]))

    def test_an_item_that_is_no_item_is_refused_with_400_the_database_never_asked(self):
        for body in ["not json", "{}", '{"name": ""}', '{"name": 7}', json.dumps({"name": "x" * 201})]:
            with self.subTest(body=body):
                db = StandIn()
                answer = app.route(request("POST", "/items", body), db.connect)

                self.assertEqual(answer["statusCode"], 400)
                self.assertRegex(json.loads(answer["body"])["message"], "JSON|1 to 200 characters")
                self.assertEqual(db.asked, [])

    def test_get_items_id_answers_the_item_or_404(self):
        db = StandIn([ITEM], [])

        found = app.route(request("GET", "/items/1"), db.connect)
        missing = app.route(request("GET", "/items/2"), db.connect)

        self.assertEqual((found["statusCode"], json.loads(found["body"])), (200, ITEM))
        self.assertEqual((missing["statusCode"], json.loads(missing["body"])), (404, {"message": "No item 2"}))
        self.assertEqual(db.asked, [("SELECT", [1]), ("SELECT", [2])])

    def test_delete_items_id_answers_204_without_a_body_or_404(self):
        db = StandIn([{"id": 1}], [])

        deleted = app.route(request("DELETE", "/items/1"), db.connect)
        missing = app.route(request("DELETE", "/items/1"), db.connect)

        self.assertEqual((deleted["statusCode"], "body" in deleted), (204, False))
        self.assertEqual(missing["statusCode"], 404)

    def test_a_path_without_a_route_is_404_and_a_method_its_route_lacks_405_with_the_methods_it_takes(self):
        db = StandIn()

        none = app.route(request("GET", "/orders"), db.connect)
        wrong = app.route(request("PUT", "/items/1"), db.connect)

        self.assertEqual((none["statusCode"], json.loads(none["body"])), (404, {"message": "No route for /orders"}))
        self.assertEqual((wrong["statusCode"], wrong["headers"]["allow"]), (405, "GET, DELETE"))
        self.assertEqual(db.asked, [])


if __name__ == "__main__":
    unittest.main()

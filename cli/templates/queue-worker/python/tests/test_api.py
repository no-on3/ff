# The API, outside its CodeUri so that no package holds it: python3 -m unittest, from the application's folder. The
# queue is a stand-in that keeps what it is sent and answers each with an ID.
import base64
import json
import pathlib
import unittest

from src import api

EVENTS = pathlib.Path(__file__).parents[1] / "events"


def request(method, path, body=None):
    return {"rawPath": path, "requestContext": {"http": {"method": method, "path": path}}, "body": body}


class StandIn:
    def __init__(self):
        self.sent = []

    def send(self, body):
        self.sent.append(json.loads(body))
        return f"id-{len(self.sent)}"


class ApiTest(unittest.TestCase):
    def test_post_jobs_puts_the_job_in_the_queue_as_it_came_and_answers_202_with_its_id(self):
        queue = StandIn()

        answer = api.route(json.loads((EVENTS / "post-job.json").read_text()), queue.send)

        self.assertEqual((answer["statusCode"], json.loads(answer["body"])), (202, {"id": "id-1", "task": "greet"}))
        self.assertEqual(queue.sent, [{"task": "greet", "name": "Amira"}])

    def test_a_body_in_base64_is_read_as_the_text_it_holds(self):
        queue = StandIn()
        body = base64.b64encode(b'{"task": "greet", "name": "Sami"}').decode()

        answer = api.route({**request("POST", "/jobs", body), "isBase64Encoded": True}, queue.send)

        self.assertEqual((answer["statusCode"], queue.sent), (202, [{"task": "greet", "name": "Sami"}]))

    def test_a_job_that_is_no_job_is_refused_with_400_nothing_sent(self):
        long = json.dumps({"task": "x" * 101})
        big = json.dumps({"task": "big", "data": "x" * 262_144})
        for body in ["not json", "[]", '"greet"', "{}", '{"task": ""}', '{"task": 7}', long, big]:
            with self.subTest(body=body[:40]):
                queue = StandIn()

                answer = api.route(request("POST", "/jobs", body), queue.send)

                self.assertEqual(answer["statusCode"], 400)
                self.assertRegex(json.loads(answer["body"])["message"], "JSON|an object|names its task|bytes at most")
                self.assertEqual(queue.sent, [])

    def test_a_path_without_a_route_is_404_and_a_method_jobs_lacks_405_with_allow(self):
        queue = StandIn()

        none = api.route(request("POST", "/orders"), queue.send)
        wrong = api.route(request("GET", "/jobs"), queue.send)

        self.assertEqual((none["statusCode"], json.loads(none["body"])), (404, {"message": "No route for /orders"}))
        self.assertEqual((wrong["statusCode"], wrong["headers"]["allow"]), (405, "POST"))
        self.assertEqual(queue.sent, [])


if __name__ == "__main__":
    unittest.main()

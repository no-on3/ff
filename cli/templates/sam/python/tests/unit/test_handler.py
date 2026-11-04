# The handler's test, outside its CodeUri so that no package holds it: python3 -m unittest, from the application's
# folder.
import json
import pathlib
import unittest

from hello_world import app

EVENT = pathlib.Path(__file__).parents[2] / "events" / "event.json"


class HandlerTest(unittest.TestCase):
    def test_a_function_url_request_is_answered_hello_world(self):
        result = app.lambda_handler(json.loads(EVENT.read_text()), None)

        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(json.loads(result["body"]), {"message": "hello world"})

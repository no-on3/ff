# The worker, outside its CodeUri so that no package holds it: python3 -m unittest, from the application's folder.
# Its batches are SQS's events, as Lambda gives them.
import json
import pathlib
import unittest

from src import worker

EVENTS = pathlib.Path(__file__).parents[1] / "events"


def record(message_id, body):
    return {"messageId": message_id, "body": body, "attributes": {"ApproximateReceiveCount": "1"}}


class WorkerTest(unittest.TestCase):
    def test_each_job_is_done_by_its_task_and_a_job_whose_task_none_does_is_named_failed_alone(self):
        event = json.loads((EVENTS / "batch.json").read_text())

        answer = worker.work(event, worker.TASKS)

        self.assertEqual(answer, {"batchItemFailures": [{"itemIdentifier": event["Records"][1]["messageId"]}]})

    def test_a_batch_done_whole_names_none(self):
        done = []
        records = [record("a", '{"task": "greet", "name": "Amira"}'), record("b", '{"task": "greet", "name": "Sami"}')]

        answer = worker.work({"Records": records}, {"greet": lambda job: done.append(job["name"])})

        self.assertEqual((answer, done), ({"batchItemFailures": []}, ["Amira", "Sami"]))

    def test_a_task_that_raises_fails_its_job_alone_and_the_jobs_after_it_are_done(self):
        done = []

        def greet(job):
            if "name" not in job:
                raise ValueError("A greeting needs a name")
            done.append(job["name"])

        records = [
            record("a", '{"task": "greet"}'),
            record("b", "not json"),
            record("c", '{"task": "greet", "name": "Sami"}'),
        ]

        answer = worker.work({"Records": records}, {"greet": greet})

        self.assertEqual(answer["batchItemFailures"], [{"itemIdentifier": "a"}, {"itemIdentifier": "b"}])
        self.assertEqual(done, ["Sami"])

    def test_a_tasks_name_is_one_of_the_tasks_own(self):
        records = [record("a", '{"task": "__init__"}'), record("b", '{"task": ["greet"]}'), record("c", "7")]

        answer = worker.work({"Records": records}, worker.TASKS)

        self.assertEqual(len(answer["batchItemFailures"]), 3)

    def test_greet_greets_the_name_it_is_given_and_needs_one(self):
        self.assertEqual(worker.greet({"task": "greet", "name": "Amira"}), "Hello Amira")
        with self.assertRaisesRegex(ValueError, "needs a name"):
            worker.greet({"task": "greet"})


if __name__ == "__main__":
    unittest.main()

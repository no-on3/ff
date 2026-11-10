# {{name}}'s worker: the queue's jobs, ten at most a call, as SQS's event gives them to Lambda, on FF as on AWS. Each
# job is done by its task's function in TASKS. One that raises, or whose task none does, is named in the answer's
# batchItemFailures, so that the queue keeps it for another try while it deletes the others, as
# ReportBatchItemFailures in template.yaml asks; a job that failed three times goes to the dead-letter queue. Each job
# done, or failed, is a line of the log.
import json


def greet(job):
    """{"task": "greet", "name": "Amira"}"""
    name = job.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("A greeting needs a name")
    return f"Hello {name}"


# What each task does, given its job, its answer a line of the log: yours to change.
TASKS = {"greet": greet}


def handler(event, context):
    return work(event, TASKS)


def work(event, tasks):
    """The batch's jobs done by the tasks given; the answer names those that failed."""
    failed = []
    for record in event["Records"]:
        tries = int(record.get("attributes", {}).get("ApproximateReceiveCount", 1))
        try:
            job = json.loads(record["body"])
            task = job.get("task") if isinstance(job, dict) else None
            if not isinstance(task, str) or task not in tasks:
                raise ValueError(f"No task {json.dumps(task)}")
            result = tasks[task](job)
            print(json.dumps({"job": record["messageId"], "task": task, "done": result}, ensure_ascii=False))
        except Exception as error:
            print(json.dumps({"job": record["messageId"], "failed": str(error), "tries": tries}, ensure_ascii=False))
            failed.append({"itemIdentifier": record["messageId"]})
    return {"batchItemFailures": failed}

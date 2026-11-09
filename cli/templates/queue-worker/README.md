# {{name}}

A queue and its worker, in {{language}}: a function's URL takes jobs, `POST /jobs` with `{"task": "…", …}`, into the queue `{{name}}-jobs` and answers 202 with each one's ID; the worker reads the queue in batches of up to ten, does each job by its task, and names those it failed, which the queue keeps for another try while it deletes the others. A job that failed three times goes to `{{name}}-jobs-dead-letters`, kept there 14 days. The same folder runs here with `ff local start`, on FF with `ff deploy`, and on AWS Lambda with `sam deploy`.

`src/` is the code of both functions, `CodeUri` in `template.yaml`: `src/api.{{extension}}` takes the jobs, and `src/worker.{{extension}}` does them, by its `TASKS`, yours to change; it has one, `greet`, `{"task": "greet", "name": "Amira"}`. `tests/` tries both, the API with a stand-in for the queue; `events/post-job.json` is a request as the URL sends it, `events/batch.json` a batch as the queue gives it to the worker, one job of a task it hasn't; and `samconfig.toml` names the stack, `{{name}}`.

A job the worker failed comes back after the queue's visibility timeout, `JobsVisibilityTimeout`, 60 seconds unless `--parameter-overrides JobsVisibilityTimeout=…` says, 10 at least, the worker's `Timeout`. The URL takes jobs from anyone: `AuthType: AWS_IAM` in `template.yaml` makes it take FF's API keys on FF, and signed requests on AWS.

## Here

```bash
{{install}}
{{test}}# the API's and the worker's tests, no queue needed
ff local start template.yaml                       # the API at http://{{name_lower}}-api.fn.localhost:3700, the worker reading the queue
curl -d '{"task": "greet", "name": "Amira"}' http://{{name_lower}}-api.fn.localhost:3700/jobs
curl -d '{"task": "resize"}' http://{{name_lower}}-api.fn.localhost:3700/jobs    # a task the worker hasn't
```

`ff local start` shows the worker's log as it comes: a line for the job done, `{"job": "…", "task": "greet", "done": "Hello Amira"}`, and one for each try of the other, `{"job": "…", "failed": "No task \"resize\"", "tries": 1}`, until the third sends it to the dead-letter queue, which the AWS CLI reads at `http://127.0.0.1:3700` with the key `ff local start` prints.

## On FF

```bash
ff deploy template.yaml                       # the stack {{name}}: the API and its URL, the worker, the two queues
ff invoke {{name}}-api --http POST /jobs --data '{"task": "greet", "name": "Amira"}'
ff logs {{name}}-worker                       # the job done: {"job": "…", "task": "greet", "done": "Hello Amira"}
ff invoke {{name}}-api --http POST /jobs --data '{"task": "resize"}'
ff queues receive {{name}}-jobs-dead-letters --wait 20s    # after three tries, the job the worker failed
```

`ff queues get {{name}}-jobs` shows the jobs waiting and those being done, and `ff event-sources list --function {{name}}-worker` how the worker reads them. `ff delete-stack` deletes both functions, the URL and the queues.

## On AWS

```bash
sam build && sam deploy --guided              # the same template, the stack {{name}}
```

`Policies` let the API's role send to the queue; SAM gives the worker's the right to read it, as its `SQS` event names it.

## The same as on AWS

The template is SAM's, within what FF takes of it; the API's handler is AWS Lambda's, given Lambda's URL event (version 2.0) and answering a URL's response; the queues are SQS's, the API's client AWS's SDK, which finds the endpoint and the key in the function's environment, a role's on AWS and the function's own on FF; the worker is given SQS's event, ten messages at most, and its answer's `batchItemFailures` keeps the jobs it names, as Lambda's `ReportBatchItemFailures` does; the dead-letter queue takes a job at its fourth receive, as SQS's `RedrivePolicy` says.

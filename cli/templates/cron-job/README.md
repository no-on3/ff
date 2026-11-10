# {{name}}

A job on a schedule, in {{language}}: each morning at 06:00 UTC, it reports the day before, the files that arrived in its bucket under `incoming/` that day, their number, their bytes and the largest, written beside them as `reports/<day>.json`. A run that fails is tried twice more, a minute then two after; then its event goes to the queue `{{name}}-failed-runs`, kept there 14 days. The same folder runs here with `ff local start`, on FF with `ff deploy`, and on AWS Lambda with `sam deploy`.

`src/` is the function's code, `CodeUri` in `template.yaml`: `src/app.{{extension}}` makes the report, yours to change, what it reads and what it writes. The day it reports is the one before the run's time, so that a run made again reports the same day; a run by hand may name it, `{"day": "2026-11-09"}`. `tests/` tries the report with a stand-in for the bucket, `events/scheduled.json` is the event the schedule sends, EventBridge's Scheduled Event, and `samconfig.toml` names the stack, `{{name}}`.

## Here

```bash
{{install}}
{{test}}# the report's tests, no bucket needed
ff local start template.yaml                       # the job and its schedule, its bucket, files here, and its queue
```

In another terminal, in the same folder:

```bash
curl -T README.md http://127.0.0.1:3700/files/incoming/README.md      # a file arrives in the bucket
curl -d "{\"day\": \"$(date -u +%F)\"}" http://127.0.0.1:3700/2015-03-31/functions/{{name}}-report/invocations
curl http://127.0.0.1:3700/files/reports/$(date -u +%F).json          # today's report, which the call made
ff local run EveryMorning                                             # the schedule's run, now: yesterday's report
```

The bucket's files are kept in `.ff/local/buckets/files/` from a start to the next; `ff local reset` removes them. A run that fails here is tried again as on FF, then its event is sent to the queue, which the AWS CLI reads at `http://127.0.0.1:3700` with the key `ff local start` prints.

## On FF

```bash
ff deploy template.yaml                       # the stack {{name}}: the job, its schedule, its bucket and its queue
bucket=<FilesBucket>                          # the bucket's name, an output of the deploy: made from the stack's
eval "$(ff keys create --bucket "$bucket" | grep '^export ')"      # a key to that bucket, for the AWS CLI
aws s3 cp README.md "s3://$bucket/incoming/README.md"
ff invoke {{name}}-report --data "{\"day\": \"$(date -u +%F)\"}"   # today's report, now
aws s3 cp "s3://$bucket/reports/$(date -u +%F).json" -
ff schedule list {{name}}-report              # its schedule, 06:00 UTC each day
ff queues receive {{name}}-failed-runs        # a run that failed three times, if any
```

Each message of `{{name}}-failed-runs` is a failed run's record, as Lambda writes it: the event under `requestPayload`, the error under `responsePayload`, and `"condition": "RetriesExhausted"`. `ff invoke {{name}}-report --data '<its requestPayload>'` runs it again, once the cause is fixed. `ff delete-stack` deletes the function, its schedule, the queue and the bucket; a bucket that holds files stops it, as it stops CloudFormation: `ff buckets delete "$bucket" --force` deletes it with them, and `ff delete-stack` again the rest.

## On AWS

```bash
sam build && sam deploy --guided              # the same template, the stack {{name}}
```

The schedule is an EventBridge rule there, and `Policies` give the function's role the bucket; SAM gives it the queue, as `EventInvokeConfig` names it its destination.

## The same as on AWS

The template is SAM's, within what FF takes of it; the handler is AWS Lambda's, given EventBridge's Scheduled Event; the schedule runs it without waiting, as an asynchronous call, which `EventInvokeConfig` retries twice and then sends to its destination, the queue, a record of Lambda's; the bucket is S3's and the queue SQS's, reached by AWS's SDK at the endpoint and with the key the function's environment gives, a role's on AWS and the function's own on FF.

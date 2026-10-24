# orders-app

A small app on FF, written as it would be for AWS Lambda: orders taken at a web address and kept in PostgreSQL, each order's receipt made in the background and kept in a bucket, and a report each night. One package, `pg` its PostgreSQL driver, `@aws-sdk/client-s3` and `@aws-sdk/client-sqs` its S3 and SQS clients, makes three functions:

| Function | Handler | Called by |
|---|---|---|
| `orders-api` | `index.http` | its function URL: `POST /orders` with `{"item": "harissa", "quantity": 2}` writes an order, then puts it in the queue of new orders, `GET /orders` lists the last 20, `GET /orders/<id>/receipt` reads an order's receipt |
| `orders-receipts` | `index.receipts` | the queue of new orders, which it reads in batches, as Lambda's event source mapping for SQS: it writes each order's receipt to the bucket, and names the messages whose receipt it couldn't write in `batchItemFailures`, so that they alone come back |
| `orders-nightly` | `index.nightly` | a schedule, `cron(0 2 * * ? *)`, which calls it without waiting, retried should it fail: the day before counted, orders older than 90 days removed, with their receipts |

`orders-api` and `orders-nightly` read `DATABASE_URL`, a secret. `RECEIPTS_QUEUE` names the queue of new orders, which `orders-api` sends each order to, and `RECEIPTS_BUCKET` the bucket, where `orders-receipts` writes the receipts, `orders-api` reads them back and `orders-nightly` removes the old ones; without the queue, `orders-api` writes each receipt itself, and without the bucket, orders go without receipts. On FF, `ff db create` makes the database and sets the secret, `ff buckets create` the bucket and `ff queues create` the queue, and each function has a key of its own to the account's buckets and queues in its environment, so the S3 and SQS clients need no setting, as on AWS Lambda with a role. The getting-started guide walks through it: [A small app, end to end](../../docs/getting-started.md#a-small-app-end-to-end). In short, from this folder:

```bash
ff deploy . --name orders-api --handler index.http
ff deploy . --name orders-receipts --handler index.receipts   # the same package: nothing uploaded
ff deploy . --name orders-nightly --handler index.nightly
ff db create orders --secret-for orders-api --secret-for orders-nightly
ff buckets create shop-receipts                                 # a name of yours: bucket names are unique across FF
ff queues create new-orders
ff env set orders-api RECEIPTS_QUEUE=new-orders RECEIPTS_BUCKET=shop-receipts
ff env set orders-receipts RECEIPTS_BUCKET=shop-receipts
ff env set orders-nightly RECEIPTS_BUCKET=shop-receipts
ff event-sources add new-orders orders-receipts --report-batch-item-failures
ff url enable orders-api --auth none
ff invoke orders-api --http POST /orders --data '{"item": "harissa", "quantity": 2}'
ff invoke orders-api --http GET /orders/1/receipt              # a moment later: orders-receipts has written it
ff schedule set orders-nightly "cron(0 2 * * ? *)"
ff invoke orders-nightly --async --data @events/scheduled.json  # a night's run, now, as its schedule calls it
```

FF's database, the bucket and the queue are reached whatever the account's internet access. A database of your own elsewhere works too, through the same secret, once FF's operator turns the account's internet access on. On AWS Lambda the same folder runs with an RDS database, an S3 bucket and an SQS queue: `ff package` writes its zip, the function's role gives the clients their credentials, and the export kit's [`data/sqs.md`](../../cli/templates/export/data/sqs.md) has the queue and the mapping. `.ffignore` leaves this README and `events/` out of the package.

# orders-app

A small app on FF, written as it would be for AWS Lambda: orders taken at a web address and kept in PostgreSQL, each order's receipt kept in a bucket, and a report each night. One package, `pg` its PostgreSQL driver and `@aws-sdk/client-s3` its S3 client, makes two functions:

| Function | Handler | Called by |
|---|---|---|
| `orders-api` | `index.http` | its function URL: `POST /orders` with `{"item": "harissa", "quantity": 2}` writes an order, then its receipt, `GET /orders` lists the last 20, `GET /orders/<id>/receipt` reads an order's receipt |
| `orders-nightly` | `index.nightly` | a schedule, `cron(0 2 * * ? *)`: the day before counted, orders older than 90 days removed, with their receipts |

Both read `DATABASE_URL`, a secret, and `RECEIPTS_BUCKET`, a variable naming the bucket; without it, orders go without receipts. On FF, `ff db create` makes the database and sets the secret, `ff buckets create` the bucket, and each function has a key of its own to the account's buckets in its environment, so the S3 client needs no setting, as on AWS Lambda with a role. The getting-started guide walks through it: [A small app, end to end](../../docs/getting-started.md#a-small-app-end-to-end). In short, from this folder:

```bash
ff deploy . --name orders-api --handler index.http
ff deploy . --name orders-nightly --handler index.nightly     # the same package: nothing uploaded
ff db create orders --secret-for orders-api --secret-for orders-nightly
ff buckets create shop-receipts                               # a name of yours: bucket names are unique across FF
ff env set orders-api RECEIPTS_BUCKET=shop-receipts
ff env set orders-nightly RECEIPTS_BUCKET=shop-receipts
ff url enable orders-api --auth none
ff invoke orders-api --http POST /orders --data '{"item": "harissa", "quantity": 2}'
ff invoke orders-api --http GET /orders/1/receipt
ff schedule set orders-nightly "cron(0 2 * * ? *)"
ff invoke orders-nightly --data @events/scheduled.json        # a night's run, now
```

FF's database and the bucket are reached whatever the account's internet access. A database of your own elsewhere works too, through the same secret, once FF's operator turns the account's internet access on. On AWS Lambda the same folder runs with an RDS database and an S3 bucket: `ff package` writes its zip, and the function's role gives the S3 client its credentials. `.ffignore` leaves this README and `events/` out of the package.

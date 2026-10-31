# orders-app

A small app on FF, written as it would be for AWS Lambda: its page a static site, orders taken at a web address and kept in PostgreSQL, the latest listed from a cache, each order's receipt made in the background, kept in a bucket and e-mailed, and a report each night. One package, `pg` its PostgreSQL driver, `@redis/client` its Valkey client, `@aws-sdk/client-s3`, `@aws-sdk/client-sqs` and `@aws-sdk/client-sesv2` its S3, SQS and SES clients, makes three functions, and `site/` is its page:

| Function | Handler | Called by |
|---|---|---|
| `orders-api` | `index.http` | its function URL: `POST /orders` with `{"item": "harissa", "quantity": 2}`, and `"email"` for its receipt, writes an order, then puts it in the queue of new orders, `GET /orders` lists the last 20 from the cache, `X-Cache` saying whether it had them, `GET /orders/<id>/receipt` reads an order's receipt |
| `orders-receipts` | `index.receipts` | the queue of new orders, which it reads in batches, as Lambda's event source mapping for SQS: it writes each order's receipt to the bucket and e-mails it to the order's address, and names the messages whose receipt it couldn't write in `batchItemFailures`, so that they alone come back; a receipt that can't be e-mailed is logged |
| `orders-nightly` | `index.nightly` | a schedule, `cron(0 2 * * ? *)`, which calls it without waiting, retried should it fail: the day before counted, orders older than 90 days removed, with their receipts |

`orders-api` and `orders-nightly` read `DATABASE_URL`, a secret, and `REDIS_URL`, another: the latest orders are kept in the cache a minute, and a new order clears them; without it, the list is read from the database each time. `RECEIPTS_FROM` is the address receipts go from, one the account proved or at a domain it proved; without it, receipts aren't e-mailed. `RECEIPTS_QUEUE` names the queue of new orders, which `orders-api` sends each order to, and `RECEIPTS_BUCKET` the bucket, where `orders-receipts` writes the receipts, `orders-api` reads them back and `orders-nightly` removes the old ones; without the queue, `orders-api` writes each receipt itself, and without the bucket, orders go without receipts. On FF, `ff db create` makes the database and sets the secret, `ff caches create` the cache and its secret, `ff buckets create` the bucket, `ff queues create` the queue and `ff email add` the domain receipts go from, and each function has a key of its own to the account's buckets, queues and mail in its environment, so the S3, SQS and SES clients need no setting, as on AWS Lambda with a role. The getting-started guide walks through it: [A small app, end to end](../../docs/getting-started.md#a-small-app-end-to-end). In short, from this folder:

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
ff caches create orders-cache --secret-for orders-api --secret-for orders-nightly
ff email add shop.example.tn                                     # publish the records it prints; then:
ff env set orders-receipts RECEIPTS_FROM=orders@shop.example.tn
ff schedule set orders-nightly "cron(0 2 * * ? *)"
ff invoke orders-nightly --async --data @events/scheduled.json  # a night's run, now, as its schedule calls it
```

The page, `site/`, reads its API's address from `config.json`, which the deploy writes beside it; the function URL lets the site's origin in:

```bash
ff buckets create shop-site                                     # a name of yours
printf '{"api": "%s"}\n' "<orders-api's URL>" > site/config.json
ff sites deploy shop-site site
ff url enable orders-api --auth none --cors-origin <the site's address> --cors-method GET --cors-method POST --cors-header content-type
```

FF's database, the cache, the bucket, the queue and the mail are reached whatever the account's internet access. A database of your own elsewhere works too, through the same secret, once FF's operator turns the account's internet access on. On AWS Lambda the same folder runs with an RDS database, an S3 bucket and an SQS queue: `ff package` writes its zip, the function's role gives the clients their credentials, and the export kit's [`data/sqs.md`](../../cli/templates/export/data/sqs.md) has the queue and the mapping, [`data/s3-website.md`](../../cli/templates/export/data/s3-website.md) the page, [`data/elasticache.md`](../../cli/templates/export/data/elasticache.md) the cache and [`data/ses.md`](../../cli/templates/export/data/ses.md) the mail. `test/handlers.test.js` tries each handler's paths with its clients stubbed, no database or cache needed: `node --test test/`, the ones FF can't show, such as a cache that can't be reached or SES refusing an e-mail. `.ffignore` leaves this README, `events/`, `site/` and `test/` out of the package.

# orders-app

A small app on FF, written as it would be for AWS Lambda: its page a static site, orders taken at a web address and kept in PostgreSQL, the latest listed from a cache, each order's receipt made in the background, kept in a bucket and e-mailed, and a report each night. One package, `pg` its PostgreSQL driver, `@redis/client` its Valkey client, `@aws-sdk/client-s3`, `@aws-sdk/client-sqs` and `@aws-sdk/client-sesv2` its S3, SQS and SES clients, makes three functions, and `site/` is its page. [`template.yaml`](template.yaml) is the app as one SAM template, which `ff deploy` makes on FF; [`samconfig.toml`](samconfig.toml) names its stack, `shop`, and its parameters' values:

| Function | Handler | Called by |
|---|---|---|
| `shop-api` | `index.http` | its function URL: `POST /orders` with `{"item": "harissa", "quantity": 2}`, and `"email"` for its receipt, writes an order, then puts it in the queue of new orders, `GET /orders` lists the last 20 from the cache, `X-Cache` saying whether it had them, `GET /orders/<id>/receipt` reads an order's receipt |
| `shop-receipts` | `index.receipts` | the queue of new orders, which it reads in batches, as Lambda's event source mapping for SQS: it writes each order's receipt to the bucket and e-mails it to the order's address, and names the messages whose receipt it couldn't write in `batchItemFailures`, so that they alone come back; a receipt that can't be e-mailed is logged |
| `shop-nightly` | `index.nightly` | a schedule, `cron(0 2 * * ? *)`, which calls it without waiting, retried should it fail: the day before counted, orders older than 90 days removed, with their receipts |

`shop-api` and `shop-nightly` read `DATABASE_URL`, a secret, and `REDIS_URL`, another: the latest orders are kept in the cache a minute, and a new order clears them; without it, the list is read from the database each time. `RECEIPTS_FROM` is the address receipts go from, one the account proved or at a domain it proved, the template's `ReceiptsFrom`; without it, receipts aren't e-mailed. `RECEIPTS_QUEUE` names the queue of new orders, which `shop-api` sends each order to, and `RECEIPTS_BUCKET` the bucket, where `shop-receipts` writes the receipts, `shop-api` reads them back and `shop-nightly` removes the old ones; without the queue, `shop-api` writes each receipt itself, and without the bucket, orders go without receipts. The template makes the functions, their URL, mapping and schedule, the queue and the two buckets, the page's a site; `ff db create` makes the database and sets its secret, `ff caches create` the cache and its secret, and `ff email add` the address receipts go from, as no resource of SAM's makes them. Each function has a key of its own to the account's buckets, queues and mail in its environment, so the S3, SQS and SES clients need no setting, as on AWS Lambda with a role. The getting-started guide walks through it: [A small app, end to end](../../docs/getting-started.md#a-small-app-end-to-end). In short, from this folder, the buckets' names in `samconfig.toml` changed to yours, as a bucket's name is unique across FF:

```bash
ff deploy template.yaml                                         # the stack shop: its buckets, its queue, its three functions
ff db create shop --secret-for shop-api --secret-for shop-nightly
ff caches create shop-cache --secret-for shop-api --secret-for shop-nightly
ff email add shop.example.tn                                     # publish the records it prints; then:
ff deploy template.yaml --parameter-overrides ReceiptsFrom=orders@shop.example.tn
ff invoke shop-api --http POST /orders --data '{"item": "harissa", "quantity": 2}'
ff invoke shop-api --http GET /orders/1/receipt                # a moment later: shop-receipts has written it
ff invoke shop-nightly --async --data @events/scheduled.json    # a night's run, now, as its schedule calls it
```

The page, `site/`, reads its API's address from `config.json`, which the deploy writes beside it; its files go to the template's site, as SAM uploads none, and the function URL lets the site's origin in, the template's `SiteOrigin`:

```bash
printf '{"api": "%s"}\n' "$(ff url show shop-api --output json | jq -r .url.functionUrl)" > site/config.json
ff sites deploy shop-site site
```

FF's database, the cache, the buckets, the queue and the mail are reached whatever the account's internet access. A database of your own elsewhere works too, through the same secret, once FF's operator turns the account's internet access on. On AWS Lambda, with an RDS database, an ElastiCache cache and SES beside it, `sam deploy` takes the template `ff export` writes from the stack, which adds `DATABASE_URL` and `REDIS_URL` as parameters CloudFormation doesn't show back; this one passes `sam validate --lint` as it is, each function's `Policies` giving its role what it uses. The export kit's [`data/sqs.md`](../../cli/templates/export/data/sqs.md) has the queue and the mapping, [`data/s3-website.md`](../../cli/templates/export/data/s3-website.md) the page, [`data/elasticache.md`](../../cli/templates/export/data/elasticache.md) the cache and [`data/ses.md`](../../cli/templates/export/data/ses.md) the mail. `test/handlers.test.js` tries each handler's paths with its clients stubbed, no database or cache needed: `node --test test/`, the ones FF can't show, such as a cache that can't be reached or SES refusing an e-mail. `.ffignore` leaves this README, the template, `samconfig.toml`, `events/`, `site/` and `test/` out of the package.

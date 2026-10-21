# orders-app

A small app on FF, written as it would be for AWS Lambda: orders taken at a web address and kept in PostgreSQL, and a report each night. One package, `pg` its driver, makes two functions:

| Function | Handler | Called by |
|---|---|---|
| `orders-api` | `index.http` | its function URL: `POST /orders` with `{"item": "harissa", "quantity": 2}` writes an order, `GET /orders` lists the last 20 |
| `orders-nightly` | `index.nightly` | a schedule, `cron(0 2 * * ? *)`: the day before counted, orders older than 90 days removed |

Both read `DATABASE_URL`, a secret. The getting-started guide walks through it, the database included: [A small app, end to end](../../docs/getting-started.md#a-small-app-end-to-end). In short, from this folder:

```bash
ff deploy . --name orders-api --handler index.http
ff secrets set orders-api DATABASE_URL            # postgres://…, from a prompt that doesn't show it
ff url enable orders-api --auth none
ff invoke orders-api --http POST /orders --data '{"item": "harissa", "quantity": 2}'
ff deploy . --name orders-nightly --handler index.nightly   # the same package: nothing uploaded
ff secrets set orders-nightly DATABASE_URL
ff schedule set orders-nightly "cron(0 2 * * ? *)"
ff invoke orders-nightly --data @events/scheduled.json      # a night's run, now
```

The functions reach the database only when the account's internet access is on, as FF's operator sets it. `.ffignore` leaves this README and `events/` out of the package.

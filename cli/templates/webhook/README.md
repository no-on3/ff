# {{name}}

Orders paid through Konnect, in {{language}}, and Konnect's notifications received right: each kept as it came, the payment asked of Konnect itself, each order paid once. The same folder runs here with `ff local start`, on FF with `ff deploy`, and on AWS Lambda with `sam deploy`.

| Route | What it does |
|---|---|
| `POST /orders` | `{"amount": 12500, "description": "…"}`, the amount in millimes: the payment made at Konnect, then 201 with the order and its `payUrl`, the page where the payer pays; 400 for a body that isn't one, 502 when Konnect made no payment |
| `GET /orders/<id>` | The order as kept here, `pending` or `paid`, Konnect asked again while it is pending; or 404 |
| `GET /webhooks/konnect?payment_ref=…` | Konnect's notification, which the payer's browser follows after paying: 200, or 303 to `ReturnUrl` |

A path without a route is 404, and a method its route lacks 405, with the methods it takes in `Allow`. `src/` is the function's code, `CodeUri` in `template.yaml`: `src/app.{{extension}}` routes the requests, and makes the tables `orders` and `notifications` at its first call if they aren't there. `tests/` tries each route with stand-ins for Konnect and for the database, `events/` holds an order and a notification as the URL sends them, and `samconfig.toml` names the stack, `{{name}}`.

## A notification received right

Konnect tells the shop about a payment by calling `webhook`, the address `POST /orders` gave it, with the payment's reference: `GET /webhooks/konnect?payment_ref=…`. Anyone can call that address, with any reference, and Konnect's call can come twice, or never. So:

1. **Each is kept as it came,** a row of `notifications` before anything else: the reference, the query, the caller's address and its user agent.
2. **Nothing in it is believed.** The payment is asked of Konnect, `GET /payments/<reference>` with the shop's key; a reference no order has is kept, and no more, and Konnect isn't asked.
3. **The order is paid when Konnect says the payment is `completed`,** for this order (its `orderId`), its amount and its currency. A payment Konnect says is `pending` has failed or isn't made yet: the order waits.
4. **Once,** by its reference: one `UPDATE … WHERE status = 'pending'`, so that two notifications at once pay it once. The line after it, marked in the code, is where a shop does what the payment is for.
5. **The browser's return is believed no more:** Konnect sends the payer's browser to the same address. With `ReturnUrl`, it goes on to the shop's page, given `?order=<id>`, which reads the order from `GET /orders/<id>`, never a state from its own address.
6. **The same answer whatever was found,** so that the answer tells a caller nothing; and `GET /orders/<id>` asks Konnect again while the order is pending, so that a notification lost is made up at the next read.

In a shop, the amount of `POST /orders` comes from its own prices, never from the request, which would let the payer choose it: `src/app.{{extension}}` marks where.

## Here

Konnect's sandbox key goes in `.env.local`, `KONNECT_API_KEY=…`, from Konnect's dashboard: `ff local start` gives its lines to the function, and the `.gitignore` leaves the file out.

```bash
{{install}}
{{test}}# the payments' tests, no Konnect and no database needed
ff local start template.yaml --with postgres --parameter-overrides KonnectWalletId=<your sandbox wallet's ID>
curl -d '{"amount": 12500, "description": "2 jars of harissa"}' http://{{name_lower}}-payments.fn.localhost:3700/orders
```

The answer's `payUrl` is Konnect's sandbox page, where nothing is really paid. Konnect's own call can't reach this machine, but the payer's browser, sent to the same address after paying, does: that is the notification here. `curl http://{{name_lower}}-payments.fn.localhost:3700/orders/<id>` then says the order, asking Konnect again while it is pending. `--with postgres` runs a PostgreSQL in Docker, its data kept from a start to the next, and gives the function its address as `DATABASE_URL`; `ff local reset --data` removes it.

## On FF

```bash
ff deploy template.yaml --parameter-overrides KonnectWalletId=<your wallet's ID>   # the stack {{name}}: its function and its URL
ff db create {{name_lower}} --secret-for {{name}}-payments  # the orders' database, its address the secret DATABASE_URL
ff secrets set {{name}}-payments KONNECT_API_KEY             # Konnect's key, at a prompt that doesn't show it
url="$(ff url show {{name}}-payments --output json | jq -r .url.functionUrl)"
curl -d '{"amount": 12500, "description": "2 jars of harissa"}' "${url}orders"
```

Konnect's notifications come to `${url}webhooks/konnect`, which `POST /orders` tells it, and `ff logs {{name}}-payments` shows each one's outcome, a line of JSON: `paid`, `already`, or `left` and why. `KonnectApiUrl` is Konnect's sandbox until `--parameter-overrides KonnectApiUrl=https://api.konnect.network/api/v2` says otherwise, with that account's key and wallet, and `ReturnUrl=https://…` names the shop's page. `ff delete-stack` deletes the function and its URL; `ff db delete {{name_lower}}` the database.

## On AWS

```bash
sam build && sam deploy --guided                           # the same template, the stack {{name}}, its parameters asked
```

The function reads `DATABASE_URL` and `KONNECT_API_KEY` as it does on FF, where they are secrets and so not in the template. On AWS they are the function's environment, added to `template.yaml` for AWS as parameters CloudFormation doesn't show back, as `ff export` writes them when it moves an app from FF:

```yaml
Parameters:
  DatabaseUrl:
    Type: String
    NoEcho: true
  KonnectApiKey:
    Type: String
    NoEcho: true
# and under the function's Environment's Variables:
          DATABASE_URL: !Ref DatabaseUrl
          KONNECT_API_KEY: !Ref KonnectApiKey
```

## The same as on AWS

The template is SAM's, within what FF takes of it; the handler is AWS Lambda's, given Lambda's URL event (version 2.0) and answering a URL's response; the database is PostgreSQL, reached by the same driver at the address in `DATABASE_URL`; Konnect is called the same way from both, its notifications coming to the function's URL. On FF the function's URL is `https://<id>.fn.<FF's domain>/`, on AWS `https://<id>.lambda-url.<region>.on.aws/`.

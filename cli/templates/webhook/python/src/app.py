# {{name}}'s payments, at its function's URL: orders paid through Konnect, and Konnect's notifications received right.
#   POST /orders             {"amount": 12500, "description": "…"}: the payment made at Konnect, 201 with the order
#                            and its payUrl, the page where the payer pays
#   GET  /orders/<id>        the order as kept here, Konnect asked again while it is pending
#   GET  /webhooks/konnect   ?payment_ref=…: Konnect's notification, which the payer's browser follows too
# A notification says which payment to ask about, and nothing in it is believed: anyone can call that address, with
# any reference. Each is kept as it came; then the payment is asked of Konnect, with the shop's key, and its order paid
# when Konnect says it is completed, for this order, its amount and its currency; once, however many notifications
# come. The address the payer's browser comes back to says nothing either: the order, read here, says it.
# The event is Lambda's URL event (version 2.0), the same on FF and on AWS Lambda. template.yaml gives the settings,
# KONNECT_API_URL, KONNECT_WALLET_ID and RETURN_URL; the two secrets stay out of it: KONNECT_API_KEY and DATABASE_URL.
import base64
import json
import os
import re
import uuid
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen


class Invalid(Exception):
    """A request that can't be taken: its answer is 400 with the message."""


class Unanswered(Exception):
    """Konnect didn't answer, or refused: nothing is paid, and a payment that wasn't made is said so."""


# Konnect's amounts are whole: millimes for dinars, cents for euros and dollars, which it takes too.
CURRENCY = "TND"
MOST = 100_000_000
# A payment's reference as Konnect writes them, letters and digits: a notification naming none is kept, and no more.
REFERENCE = re.compile(r"[0-9A-Za-z_-]{1,64}")


def handler(event, context):
    return route(event, shop)


def route(event, open_shop):
    """The request's answer, the shop given by `open_shop` when its route needs it: the tests give their own."""
    method = event["requestContext"]["http"]["method"]
    path = event["rawPath"]
    paths = [one for one in ROUTES if one[1].fullmatch(path)]
    if not paths:
        return answer(404, {"message": f"No route for {path}"})
    found = next((one for one in paths if one[0] == method), None)
    if found is None:
        allowed = ", ".join(verb for verb, _, _ in paths)
        return answer(405, {"message": f"{path} takes {allowed}, not {method}"}, {"allow": allowed})
    _, pattern, run = found
    groups = pattern.fullmatch(path).groups()
    try:
        return run(open_shop(), event, groups[0] if groups else None)
    except Invalid as error:
        return answer(400, {"message": str(error)})


def checkout(shop, event, _):
    """POST /orders: the payment made at Konnect first, then the order kept with its reference."""
    # A shop's amount comes from its own prices, never from the payer's request: here is where it reckons it.
    amount, description = order_of(body_of(event))
    id = str(uuid.uuid4())
    try:
        webhook = f"{address_of(event)}/webhooks/konnect"
        payment = shop.konnect.init_payment(amount, description, id, webhook)
    except Unanswered as error:
        log({"unpaid": id, "why": f"no payment made: Konnect {error}"})
        return answer(502, {"message": "Konnect made no payment: try again"})
    kept = shop.store.create(id, amount, CURRENCY, description, payment["paymentRef"])
    log({"ordered": id, "amount": amount, "paymentRef": payment["paymentRef"]})
    return answer(201, {**kept, "payUrl": payment["payUrl"]}, {"location": f"/orders/{id}"})


def order(shop, _, id):
    """GET /orders/<id>: the order as kept, Konnect asked again while it is pending, as a notification may not come."""
    found = shop.store.order(id)
    if found is None:
        return answer(404, {"message": f"No order {id}"})
    if found["status"] == "pending":
        settle(shop, found)
    return answer(200, shop.store.order(id))


def notified(shop, event, _):
    """GET /webhooks/konnect: the notification kept as it came, then its payment asked of Konnect."""
    reference = (event.get("queryStringParameters") or {}).get("payment_ref")
    shop.store.keep(
        {
            "provider": "konnect",
            "payment_ref": reference,
            "query": event.get("rawQueryString") or "",
            "source_ip": event["requestContext"]["http"].get("sourceIp"),
            "user_agent": (event.get("headers") or {}).get("user-agent"),
        }
    )
    if reference is None or not REFERENCE.fullmatch(reference):
        log({"left": reference, "why": "no payment reference"})
        return answer(400, {"message": "A notification names its payment: ?payment_ref=<its reference>"})
    found = shop.store.order_by_reference(reference)
    if found is None:
        log({"left": reference, "why": "no order has this payment"})
    elif found["status"] == "paid":
        log({"already": found["id"], "paymentRef": reference})
    else:
        settle(shop, found)
    # The same answer whatever was found, for Konnect's call and for the payer's browser alike.
    if not shop.return_url:
        return {"statusCode": 200, "headers": {"content-type": "text/plain"}, "body": "Received"}
    return {"statusCode": 303, "headers": {"location": back_to(shop.return_url, found)}}


def settle(shop, kept):
    """Asks Konnect about the order's payment, and pays the order if Konnect says it is paid: once, by its reference."""
    try:
        payment = shop.konnect.payment(kept["paymentRef"])
    except Unanswered as error:
        log({"left": kept["paymentRef"], "why": f"Konnect {error}"})
        return
    why = unpaid(payment, kept)
    if why:
        log({"left": kept["paymentRef"], "why": why})
    elif shop.store.paid(kept["id"], kept["paymentRef"]):
        # Here a shop does what a payment is for, its order sent, its receipt: this runs once for each order paid.
        log({"paid": kept["id"], "amount": kept["amount"], "paymentRef": kept["paymentRef"]})
    else:
        log({"already": kept["id"], "paymentRef": kept["paymentRef"]})


def unpaid(payment, kept):
    """Why Konnect's payment doesn't pay the order, or None when it does."""
    status = (payment or {}).get("status")
    if status != "completed":
        return f"Konnect says {status or 'nothing'}"
    if payment.get("orderId") != kept["id"]:
        return f"Konnect's payment is for the order {payment.get('orderId')}"
    if payment.get("amount") != kept["amount"] or payment.get("token") != kept["currency"]:
        return (
            f"Konnect's payment is {payment.get('amount')} {payment.get('token')}, "
            f"the order {kept['amount']} {kept['currency']}"
        )
    return None


ROUTES = [
    ("POST", re.compile(r"/orders/?"), checkout),
    ("GET", re.compile(r"/orders/([0-9a-f-]{36})"), order),
    ("GET", re.compile(r"/webhooks/konnect/?"), notified),
]


def body_of(event):
    text = event.get("body") or ""
    if event.get("isBase64Encoded"):
        text = base64.b64decode(text).decode("utf-8")
    try:
        return json.loads(text)
    except ValueError:
        raise Invalid('The body is JSON: {"amount": <millimes>, "description": "…"}')


def order_of(body):
    body = body if isinstance(body, dict) else {}
    description = body.get("description")
    description = description.strip() if isinstance(description, str) else ""
    amount = body.get("amount")
    whole = isinstance(amount, int) and not isinstance(amount, bool) and 1 <= amount <= MOST
    if not whole or not 0 < len(description) <= 200:
        raise Invalid(
            'An order is {"amount": <millimes>, "description": "…"}: its amount a whole number of millimes, '
            f"1 to {MOST}, its description 1 to 200 characters"
        )
    return amount, description


def address_of(event):
    """The function's own address, as its caller reached it: Konnect calls back there."""
    headers = event.get("headers") or {}
    host = headers.get("host") or event["requestContext"]["domainName"]
    # Here, ff local start answers plain http; elsewhere the URL is https, which a proxy before it may say.
    local = re.fullmatch(r"(localhost|127\.0\.0\.1|[^:]+\.localhost)(:\d+)?", host)
    scheme = (headers.get("x-forwarded-proto") or "").split(",")[0].strip() or ("http" if local else "https")
    return f"{scheme}://{host}"


def back_to(return_url, found):
    """The shop's page, given the order when the notification named one: the page reads its state here."""
    if found is None:
        return return_url
    parts = urlsplit(return_url)
    query = "&".join(part for part in (parts.query, urlencode({"order": found["id"]})) if part)
    return urlunsplit(parts._replace(query=query))


def log(line):
    print(json.dumps(line, ensure_ascii=False))


def answer(status, body, headers=None):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", **(headers or {})},
        "body": json.dumps(body, ensure_ascii=False),
    }


class Shop:
    def __init__(self, store, konnect, return_url):
        self.store = store
        self.konnect = konnect
        self.return_url = return_url


# The shop, made at the instance's first call that needs it and kept for the calls after, as an instance takes one
# call at a time: the database, its tables made then if they aren't there, and Konnect.
_shop = None


def shop():
    global _shop
    if _shop is None or _shop.store.connection.closed:
        _shop = Shop(database(), Konnect(), os.environ.get("RETURN_URL", ""))
    return _shop


def utc(column):
    return f"""to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')"""


# An order's columns as the API answers them; its ID as text, which psycopg would read as a UUID.
ORDER = (
    'id::text AS id, amount, currency, description, payment_ref AS "paymentRef", status, '
    f'{utc("created_at")} AS "createdAt", {utc("paid_at")} AS "paidAt"'
)


class Database:
    """The orders and the notifications, in PostgreSQL."""

    def __init__(self, connection):
        self.connection = connection

    def rows(self, text, values=()):
        cursor = self.connection.execute(text, values)
        return cursor.fetchall() if cursor.description else []

    def keep(self, notification):
        columns = ("provider", "payment_ref", "query", "source_ip", "user_agent")
        self.rows(
            f"INSERT INTO notifications ({', '.join(columns)}) VALUES (%s, %s, %s, %s, %s)",
            [notification[column] for column in columns],
        )

    def create(self, id, amount, currency, description, payment_ref):
        [kept] = self.rows(
            f"""INSERT INTO orders (id, amount, currency, description, payment_ref) VALUES (%s, %s, %s, %s, %s)
                RETURNING {ORDER}""",
            [id, amount, currency, description, payment_ref],
        )
        return kept

    def order(self, id):
        found = self.rows(f"SELECT {ORDER} FROM orders WHERE id = %s", [id])
        return found[0] if found else None

    def order_by_reference(self, reference):
        found = self.rows(f"SELECT {ORDER} FROM orders WHERE payment_ref = %s", [reference])
        return found[0] if found else None

    def paid(self, id, reference):
        # One statement, so that two notifications at once pay the order once: the second finds it paid.
        return bool(
            self.rows(
                """UPDATE orders SET status = 'paid', paid_at = now()
                   WHERE id = %s AND payment_ref = %s AND status = 'pending' RETURNING id""",
                [id, reference],
            )
        )


def database():
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set: the database is the function's secret, see README.md")
    # Loaded here, so that the tests run without it installed.
    import psycopg
    from psycopg.rows import dict_row

    connection = psycopg.connect(url, autocommit=True, connect_timeout=3, row_factory=dict_row)
    connection.execute(
        """CREATE TABLE IF NOT EXISTS orders (
            id uuid PRIMARY KEY,
            amount integer NOT NULL CHECK (amount > 0),
            currency text NOT NULL,
            description text NOT NULL,
            payment_ref text NOT NULL UNIQUE,
            status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
            created_at timestamptz NOT NULL DEFAULT now(),
            paid_at timestamptz);
        CREATE TABLE IF NOT EXISTS notifications (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            provider text NOT NULL,
            payment_ref text,
            query text NOT NULL,
            source_ip text,
            user_agent text,
            received_at timestamptz NOT NULL DEFAULT now())"""
    )
    return Database(connection)


class Konnect:
    """Konnect's API, as its documentation describes it: the key in x-api-key, JSON both ways."""

    def __init__(self):
        self.api = os.environ.get("KONNECT_API_URL", "").rstrip("/")
        self.key = os.environ.get("KONNECT_API_KEY")
        self.wallet = os.environ.get("KONNECT_WALLET_ID")
        settings = (("KONNECT_API_URL", self.api), ("KONNECT_API_KEY", self.key), ("KONNECT_WALLET_ID", self.wallet))
        for name, value in settings:
            if not value:
                raise RuntimeError(f"{name} is not set: Konnect's settings are the function's, see README.md")

    def call(self, method, path, body=None):
        headers = {"x-api-key": self.key}
        data = None
        if body is not None:
            headers["content-type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = Request(f"{self.api}{path}", data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=5) as answered:
                return json.load(answered)
        except HTTPError as error:
            raise Unanswered(f"answered {error.code}: {error.read().decode('utf-8', 'replace')[:200]}")
        except OSError as error:
            raise Unanswered(f"didn't answer: {getattr(error, 'reason', error)}")

    def init_payment(self, amount, description, order_id, webhook):
        """POST /payments/init-payment: the amount, the wallet it goes to, the order's ID and the address to notify."""
        made = self.call(
            "POST",
            "/payments/init-payment",
            {
                "receiverWalletId": self.wallet,
                "token": CURRENCY,
                "amount": amount,
                "type": "immediate",
                "description": description,
                "orderId": order_id,
                "webhook": webhook,
            },
        )
        return {"payUrl": made["payUrl"], "paymentRef": made["paymentRef"]}

    def payment(self, reference):
        """GET /payments/<reference>: the payment as Konnect has it, its status completed or pending."""
        return self.call("GET", f"/payments/{quote(reference, safe='')}").get("payment")

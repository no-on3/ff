# The payments, outside the CodeUri so that no package holds them: python3 -m unittest, from the application's
# folder. The database is a stand-in that keeps the orders and the notifications in lists, and Konnect one that answers
# each payment as the test says, so that the tests need neither; the log is read to see what was paid, and how often.
import io
import json
import pathlib
import unittest
from contextlib import redirect_stdout

from src import app

EVENTS = pathlib.Path(__file__).parents[1] / "events"
REF = "5f9498735289e405fc7c18ac"
ID = "0b6e1d4a-8c2f-4f3e-9a7b-5d6c4e3f2a1b"


def event(name):
    return json.loads((EVENTS / name).read_text())


def request(method, path, body=None, query=None, host="abc.lambda-url.eu-west-3.on.aws", proto="https"):
    headers = {"host": host, "user-agent": "curl/8"}
    if proto:
        headers["x-forwarded-proto"] = proto
    return {
        "rawPath": path,
        "rawQueryString": "&".join(f"{key}={value}" for key, value in (query or {}).items()),
        "queryStringParameters": query,
        "headers": headers,
        "requestContext": {"domainName": host.split(":")[0], "http": {"method": method, "sourceIp": "203.0.113.24"}},
        "body": body,
        "isBase64Encoded": False,
    }


def pending():
    """A pending order of 12.500 TND, Konnect's payment REF."""
    return {"id": ID, "amount": 12500, "currency": "TND", "description": "2 jars of harissa", "paymentRef": REF}


def payment(**fields):
    """Konnect's answer for that order's payment, completed unless said."""
    return {"id": REF, "status": "completed", "amount": 12500, "token": "TND", "orderId": ID, **fields}


class StandIn:
    """A shop of stand-ins: its orders, Konnect's payments by reference, or Konnect down; what each was asked.
    `racing` reads each order as it was before any notification paid it, as a notification at the same time would."""

    def __init__(self, orders=(), payments=None, down=False, return_url="", racing=False):
        self.rows = [{"status": "pending", "paidAt": None, **order} for order in orders]
        self.payments = payments or {}
        self.down = down
        self.racing = racing
        self.return_url = return_url
        self.kept, self.made, self.asked = [], [], []
        self.store = self
        self.konnect = self

    def open(self):
        return self

    # The store's
    def keep(self, notification):
        self.kept.append(notification)

    def create(self, id, amount, currency, description, payment_ref):
        row = {"id": id, "amount": amount, "currency": currency, "description": description, "paymentRef": payment_ref}
        self.rows.append({**row, "status": "pending", "createdAt": "2026-11-09T09:00:00Z", "paidAt": None})
        return dict(self.rows[-1])

    def order(self, id):
        return next((dict(row) for row in self.rows if row["id"] == id), None)

    def order_by_reference(self, reference):
        found = next((dict(row) for row in self.rows if row["paymentRef"] == reference), None)
        return {**found, "status": "pending", "paidAt": None} if found and self.racing else found

    def paid(self, id, reference):
        for row in self.rows:
            if row["id"] == id and row["paymentRef"] == reference and row["status"] == "pending":
                row.update(status="paid", paidAt="2026-11-09T09:02:00Z")
                return True
        return False

    # Konnect's
    def init_payment(self, amount, description, order_id, webhook):
        self.made.append({"amount": amount, "description": description, "orderId": order_id, "webhook": webhook})
        if self.down:
            raise app.Unanswered("didn't answer: [Errno 111] Connection refused")
        return {"payUrl": f"https://gateway.sandbox.konnect.network/pay?payment_ref={REF}", "paymentRef": REF}

    def payment(self, reference):
        self.asked.append(reference)
        if self.down:
            raise app.Unanswered("didn't answer: [Errno 111] Connection refused")
        return self.payments.get(reference)


def logged(call):
    """The call's answer, and the lines it logs, as JSON."""
    out = io.StringIO()
    with redirect_stdout(out):
        answered = call()
    return answered, [json.loads(line) for line in out.getvalue().splitlines()]


def notification(reference=REF):
    return request("GET", "/webhooks/konnect", query={"payment_ref": reference})


class Orders(unittest.TestCase):
    def test_post_orders_makes_the_payment_at_konnect_its_notifications_to_this_url_then_keeps_the_order(self):
        shop = StandIn()
        answered, _ = logged(lambda: app.route(event("create-order.json"), shop.open))

        order = json.loads(answered["body"])
        self.assertEqual([answered["statusCode"], answered["headers"]["location"]], [201, f"/orders/{order['id']}"])
        webhook = "https://a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6.lambda-url.eu-west-3.on.aws/webhooks/konnect"
        asked = {"amount": 12500, "description": "2 jars of harissa", "orderId": order["id"], "webhook": webhook}
        self.assertEqual(shop.made, [asked])
        self.assertEqual(
            [order["amount"], order["currency"], order["status"], order["paymentRef"], order["payUrl"]],
            [12500, "TND", "pending", REF, f"https://gateway.sandbox.konnect.network/pay?payment_ref={REF}"],
        )
        self.assertEqual(len(shop.rows), 1)

    def test_here_the_notifications_come_to_plain_http_at_the_port_ff_local_start_answers(self):
        shop = StandIn()
        body = '{"amount": 1000, "description": "a jar"}'
        for host in ("shop-payments.fn.localhost:3700", "127.0.0.1:3700"):
            logged(lambda: app.route(request("POST", "/orders", body, host=host, proto=None), shop.open))

        self.assertEqual(
            [made["webhook"] for made in shop.made],
            ["http://shop-payments.fn.localhost:3700/webhooks/konnect", "http://127.0.0.1:3700/webhooks/konnect"],
        )

    def test_an_order_that_is_no_order_is_refused_with_400_konnect_never_asked(self):
        bodies = [
            "not json",
            "{}",
            '{"amount": 12.5, "description": "a"}',
            '{"amount": 0, "description": "a"}',
            '{"amount": "12500", "description": "a"}',
            '{"amount": true, "description": "a"}',
            '{"amount": 100000001, "description": "a"}',
            '{"amount": 1000, "description": " "}',
            json.dumps({"amount": 1000, "description": "x" * 201}),
        ]
        for body in bodies:
            shop = StandIn()
            answered = app.route(request("POST", "/orders", body), shop.open)

            self.assertEqual(answered["statusCode"], 400, body)
            self.assertRegex(json.loads(answered["body"])["message"], "JSON|whole number of millimes")
            self.assertEqual([shop.made, shop.rows], [[], []])

    def test_konnect_down_502_nothing_kept_the_payer_told_to_try_again(self):
        shop = StandIn(down=True)
        answered, lines = logged(lambda: app.route(event("create-order.json"), shop.open))

        message = json.loads(answered["body"])["message"]
        self.assertEqual([answered["statusCode"], message], [502, "Konnect made no payment: try again"])
        self.assertEqual(shop.rows, [])
        self.assertRegex(lines[0]["why"], "^no payment made: Konnect didn't answer")

    def test_get_orders_says_the_order_as_kept_whatever_its_address_s_parameters_say(self):
        shop = StandIn([pending()], {REF: payment(status="pending")})
        read = request("GET", f"/orders/{ID}", query={"status": "paid", "payment_ref": REF})
        answered, _ = logged(lambda: app.route(read, shop.open))

        status = json.loads(answered["body"])["status"]
        self.assertEqual([answered["statusCode"], status, shop.asked], [200, "pending", [REF]])

        # Paid at Konnect, its notification lost: asking again pays it; then read as kept, Konnect not asked again.
        paid_then = StandIn([pending()], {REF: payment()})
        again, _ = logged(lambda: app.route(read, paid_then.open))
        last, _ = logged(lambda: app.route(read, paid_then.open))
        statuses = [json.loads(one["body"])["status"] for one in (again, last)]
        self.assertEqual([statuses, paid_then.asked], [["paid", "paid"], [REF]])


class Notifications(unittest.TestCase):
    def test_a_notification_is_kept_as_it_came_konnect_asked_and_the_order_paid_once_however_many_come(self):
        shop = StandIn([pending()], {REF: payment()})
        answered, lines = logged(
            lambda: [app.route(event("notification.json"), shop.open), app.route(event("notification.json"), shop.open)]
        )

        self.assertEqual([answered[0]["statusCode"], answered[0]["body"]], [200, "Received"])
        self.assertEqual(
            shop.kept[0],
            {
                "provider": "konnect",
                "payment_ref": REF,
                "query": f"payment_ref={REF}",
                "source_ip": "203.0.113.24",
                "user_agent": "curl/8.5.0",
            },
        )
        self.assertEqual([len(shop.kept), shop.asked], [2, [REF]])
        self.assertEqual(lines, [{"paid": ID, "amount": 12500, "paymentRef": REF}, {"already": ID, "paymentRef": REF}])
        self.assertEqual([shop.rows[0]["status"], shop.rows[0]["paidAt"]], ["paid", "2026-11-09T09:02:00Z"])

    def test_two_notifications_at_once_konnect_asked_twice_the_order_paid_once(self):
        shop = StandIn([pending()], {REF: payment()}, racing=True)
        _, lines = logged(lambda: [app.route(notification(), shop.open) for _ in range(2)])

        self.assertEqual([shop.asked, [next(iter(line)) for line in lines]], [[REF, REF], ["paid", "already"]])

    def test_a_notification_no_order_has_a_forged_one_is_kept_and_no_more_konnect_isn_t_asked(self):
        shop = StandIn([pending()], {REF: payment()})
        answered, lines = logged(lambda: app.route(notification("a" * 24), shop.open))

        self.assertEqual([answered["statusCode"], answered["body"]], [200, "Received"])
        self.assertEqual([len(shop.kept), shop.asked, shop.rows[0]["status"]], [1, [], "pending"])
        self.assertEqual(lines, [{"left": "a" * 24, "why": "no order has this payment"}])

    def test_a_payment_konnect_doesn_t_say_is_this_order_s_completed_pays_nothing(self):
        cases = [
            (payment(status="pending"), "Konnect says pending"),
            (payment(orderId="another"), "Konnect's payment is for the order another"),
            (payment(amount=125), "Konnect's payment is 125 TND, the order 12500 TND"),
            (payment(token="EUR"), "Konnect's payment is 12500 EUR, the order 12500 TND"),
            (None, "Konnect says nothing"),
        ]
        for answer, why in cases:
            shop = StandIn([pending()], {REF: answer})
            answered, lines = logged(lambda: app.route(notification(), shop.open))

            expected = [200, "pending", [{"left": REF, "why": why}]]
            self.assertEqual([answered["statusCode"], shop.rows[0]["status"], lines], expected, why)

    def test_konnect_down_at_a_notification_the_order_stays_pending_the_same_answer_the_notification_kept(self):
        shop = StandIn([pending()], down=True)
        answered, lines = logged(lambda: app.route(notification(), shop.open))

        self.assertEqual([answered["statusCode"], shop.rows[0]["status"], len(shop.kept)], [200, "pending", 1])
        self.assertRegex(lines[0]["why"], "^Konnect didn't answer")

    def test_a_notification_without_a_reference_is_kept_and_refused_with_400(self):
        for query in (None, {"payment_ref": ""}, {"payment_ref": "../orders"}):
            shop = StandIn([pending()])
            answered, _ = logged(lambda: app.route(request("GET", "/webhooks/konnect", query=query), shop.open))

            self.assertEqual([answered["statusCode"], len(shop.kept), shop.asked], [400, 1, []], query)

    def test_with_return_url_the_payer_s_browser_goes_back_to_the_shop_s_page_given_the_order_and_no_state(self):
        shop = StandIn([pending()], {REF: payment()}, return_url="https://shop.example.tn/paid")
        answered, _ = logged(lambda: app.route(event("notification.json"), shop.open))
        elsewhere, _ = logged(lambda: app.route(notification("b" * 24), shop.open))

        back = [answered["statusCode"], answered["headers"]["location"]]
        self.assertEqual(back, [303, f"https://shop.example.tn/paid?order={ID}"])
        self.assertEqual([elsewhere["statusCode"], elsewhere["headers"]["location"]], [303, shop.return_url])


class Routes(unittest.TestCase):
    def test_an_order_no_one_has_is_404_a_path_without_a_route_404_a_method_its_route_lacks_405_with_allow(self):
        shop = StandIn()
        answers = [
            app.route(request("GET", "/orders/0b6e1d4a-8c2f-4f3e-9a7b-000000000000"), shop.open),
            app.route(request("GET", "/payments"), shop.open),
            app.route(request("POST", "/webhooks/konnect"), shop.open),
            app.route(request("DELETE", f"/orders/{ID}"), shop.open),
        ]

        self.assertEqual(
            [[one["statusCode"], one["headers"].get("allow")] for one in answers],
            [[404, None], [404, None], [405, "GET"], [405, "GET"]],
        )


if __name__ == "__main__":
    unittest.main()

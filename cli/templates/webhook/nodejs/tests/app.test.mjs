// The payments, outside the CodeUri so that no package holds them: node --test, from the application's folder.
// The database is a stand-in that keeps the orders and the notifications in arrays, and Konnect one that answers each
// payment as the test says, so that the tests need neither; the log is read to see what was paid, and how often.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { Unanswered, route } from '../src/app.mjs';

const event = async (name) => JSON.parse(await readFile(new URL(`../events/${name}`, import.meta.url), 'utf8'));
const REF = '5f9498735289e405fc7c18ac';
const ID = '0b6e1d4a-8c2f-4f3e-9a7b-5d6c4e3f2a1b';

function request(method, path, { body, query, host = 'abc.lambda-url.eu-west-3.on.aws', proto = 'https' } = {}) {
  return {
    rawPath: path,
    rawQueryString: query ? new URLSearchParams(query).toString() : '',
    queryStringParameters: query,
    headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}), 'user-agent': 'curl/8' },
    requestContext: { domainName: host.replace(/:\d+$/, ''), http: { method, path, sourceIp: '203.0.113.24' } },
    body,
    isBase64Encoded: false,
  };
}

/** A pending order of 12.500 TND, Konnect's payment REF. */
const pending = () => ({ id: ID, amount: 12500, currency: 'TND', description: '2 jars of harissa', paymentRef: REF });
/** Konnect's answer for that order's payment, completed unless said. */
const payment = (fields = {}) => ({
  id: REF,
  status: 'completed',
  amount: 12500,
  token: 'TND',
  orderId: ID,
  ...fields,
});

/** A shop of stand-ins: its orders, Konnect's payments by reference, or Konnect down; what each was asked. */
function standIn({ orders = [], payments = {}, down = false, returnUrl = '' } = {}) {
  const kept = [];
  const made = [];
  const asked = [];
  const rows = orders.map((order) => ({ status: 'pending', paidAt: null, ...order }));
  const store = {
    keep: async (notification) => void kept.push(notification),
    create: async (order) => {
      rows.push({ ...order, status: 'pending', createdAt: '2026-11-09T09:00:00Z', paidAt: null });
      return rows.at(-1);
    },
    order: async (id) => rows.find((row) => row.id === id) ?? null,
    orderByReference: async (reference) => rows.find((row) => row.paymentRef === reference) ?? null,
    paid: async (id, reference) => {
      const row = rows.find((one) => one.id === id && one.paymentRef === reference && one.status === 'pending');
      if (row) Object.assign(row, { status: 'paid', paidAt: '2026-11-09T09:02:00Z' });
      return Boolean(row);
    },
  };
  const konnect = {
    initPayment: async (asking) => {
      made.push(asking);
      if (down) throw new Unanswered("didn't answer: connect ECONNREFUSED");
      return { payUrl: `https://gateway.sandbox.konnect.network/pay?payment_ref=${REF}`, paymentRef: REF };
    },
    payment: async (reference) => {
      asked.push(reference);
      if (down) throw new Unanswered("didn't answer: connect ECONNREFUSED");
      return payments[reference];
    },
  };
  return { kept, made, asked, rows, open: async () => ({ store, konnect, returnUrl }) };
}

/** The lines the call logs, as JSON, while it runs. */
async function logged(t, call) {
  const log = t.mock.method(console, 'log', () => {});
  const answered = await call();
  return { answered, lines: log.mock.calls.map(({ arguments: [line] }) => JSON.parse(line)) };
}

test('POST /orders makes the payment at Konnect, its notifications to this URL, then keeps the order', async (t) => {
  const shop = standIn();
  const { answered } = await logged(t, async () => route(await event('create-order.json'), shop.open));

  const order = JSON.parse(answered.body);
  assert.equal(answered.statusCode, 201);
  assert.equal(answered.headers.location, `/orders/${order.id}`);
  assert.deepEqual(shop.made, [
    {
      amount: 12500,
      description: '2 jars of harissa',
      orderId: order.id,
      webhook: 'https://a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6.lambda-url.eu-west-3.on.aws/webhooks/konnect',
    },
  ]);
  assert.deepEqual(
    [order.amount, order.currency, order.status, order.paymentRef, order.payUrl],
    [12500, 'TND', 'pending', REF, `https://gateway.sandbox.konnect.network/pay?payment_ref=${REF}`],
  );
  assert.equal(shop.rows.length, 1);
});

test('here, the notifications come to plain http, at the port ff local start answers', async (t) => {
  const shop = standIn();
  const body = '{"amount": 1000, "description": "a jar"}';
  for (const host of ['shop-payments.fn.localhost:3700', '127.0.0.1:3700']) {
    await logged(t, () => route(request('POST', '/orders', { body, host, proto: null }), shop.open));
  }

  assert.deepEqual(
    shop.made.map(({ webhook }) => webhook),
    ['http://shop-payments.fn.localhost:3700/webhooks/konnect', 'http://127.0.0.1:3700/webhooks/konnect'],
  );
});

test('an order that is no order is refused with 400, Konnect never asked', async () => {
  const bodies = ['not json', '{}', '{"amount": 12.5, "description": "a"}', '{"amount": 0, "description": "a"}',
    '{"amount": "12500", "description": "a"}', '{"amount": 100000001, "description": "a"}',
    '{"amount": 1000, "description": " "}', JSON.stringify({ amount: 1000, description: 'x'.repeat(201) })];
  for (const body of bodies) {
    const shop = standIn();
    const answered = await route(request('POST', '/orders', { body }), shop.open);

    assert.equal(answered.statusCode, 400, body);
    assert.match(JSON.parse(answered.body).message, /JSON|whole number of millimes/);
    assert.deepEqual([shop.made, shop.rows], [[], []]);
  }
});

test('Konnect down: 502, nothing kept, the payer told to try again', async (t) => {
  const shop = standIn({ down: true });
  const { answered, lines } = await logged(t, async () => route(await event('create-order.json'), shop.open));

  const { message } = JSON.parse(answered.body);
  assert.deepEqual([answered.statusCode, message], [502, 'Konnect made no payment: try again']);
  assert.deepEqual(shop.rows, []);
  assert.match(lines[0].why, /^no payment made: Konnect didn't answer/);
});

test("a notification is kept as it came, Konnect asked, and the order paid once, however many come", async (t) => {
  const shop = standIn({ orders: [pending()], payments: { [REF]: payment() } });
  const notification = await event('notification.json');
  const { answered, lines } = await logged(t, async () => {
    const first = await route(notification, shop.open);
    await route(notification, shop.open);
    return first;
  });

  assert.deepEqual([answered.statusCode, answered.body], [200, 'Received']);
  assert.deepEqual(shop.kept[0], {
    provider: 'konnect',
    paymentRef: REF,
    query: `payment_ref=${REF}`,
    sourceIp: '203.0.113.24',
    userAgent: 'curl/8.5.0',
  });
  assert.equal(shop.kept.length, 2);
  assert.deepEqual(shop.asked, [REF]);
  assert.deepEqual(lines, [{ paid: ID, amount: 12500, paymentRef: REF }, { already: ID, paymentRef: REF }]);
  assert.deepEqual([shop.rows[0].status, shop.rows[0].paidAt], ['paid', '2026-11-09T09:02:00Z']);
});

test('two notifications at once: Konnect asked twice, the order paid once', async (t) => {
  const shop = standIn({ orders: [pending()], payments: { [REF]: payment() } });
  const notification = request('GET', '/webhooks/konnect', { query: { payment_ref: REF } });
  const both = () => Promise.all([route(notification, shop.open), route(notification, shop.open)]);
  const { lines } = await logged(t, both);

  assert.deepEqual(shop.asked, [REF, REF]);
  assert.deepEqual(lines.map((line) => Object.keys(line)[0]).sort(), ['already', 'paid']);
});

test("a notification no order has, a forged one, is kept, and no more: Konnect isn't asked", async (t) => {
  const shop = standIn({ orders: [pending()], payments: { [REF]: payment() } });
  const forged = request('GET', '/webhooks/konnect', { query: { payment_ref: 'aaaaaaaaaaaaaaaaaaaaaaaa' } });
  const { answered, lines } = await logged(t, () => route(forged, shop.open));

  assert.deepEqual([answered.statusCode, answered.body], [200, 'Received']);
  assert.deepEqual([shop.kept.length, shop.asked, shop.rows[0].status], [1, [], 'pending']);
  assert.deepEqual(lines, [{ left: 'aaaaaaaaaaaaaaaaaaaaaaaa', why: 'no order has this payment' }]);
});

test("a payment Konnect doesn't say is this order's, completed, pays nothing", async (t) => {
  const cases = [
    [payment({ status: 'pending' }), 'Konnect says pending'],
    [payment({ orderId: 'another' }), "Konnect's payment is for the order another"],
    [payment({ amount: 125 }), "Konnect's payment is 125 TND, the order 12500 TND"],
    [payment({ token: 'EUR' }), "Konnect's payment is 12500 EUR, the order 12500 TND"],
    [undefined, 'Konnect says nothing'],
  ];
  for (const [answer, why] of cases) {
    const shop = standIn({ orders: [pending()], payments: { [REF]: answer } });
    const notification = request('GET', '/webhooks/konnect', { query: { payment_ref: REF } });
    const { answered, lines } = await logged(t, () => route(notification, shop.open));

    assert.deepEqual([answered.statusCode, shop.rows[0].status, lines], [200, 'pending', [{ left: REF, why }]], why);
  }
});

test("Konnect down at a notification: the order stays pending, the same answer, the notification kept", async (t) => {
  const shop = standIn({ orders: [pending()], down: true });
  const notification = request('GET', '/webhooks/konnect', { query: { payment_ref: REF } });
  const { answered, lines } = await logged(t, () => route(notification, shop.open));

  assert.deepEqual([answered.statusCode, shop.rows[0].status, shop.kept.length], [200, 'pending', 1]);
  assert.match(lines[0].why, /^Konnect didn't answer/);
});

test('a notification without a reference is kept, and refused with 400', async (t) => {
  for (const query of [undefined, { payment_ref: '' }, { payment_ref: '../orders' }]) {
    const shop = standIn({ orders: [pending()] });
    const { answered } = await logged(t, () => route(request('GET', '/webhooks/konnect', { query }), shop.open));

    assert.deepEqual([answered.statusCode, shop.kept.length, shop.asked], [400, 1, []], JSON.stringify(query));
  }
});

test("with RETURN_URL, the payer's browser goes back to the shop's page, given the order and no state", async (t) => {
  const returnUrl = 'https://shop.example.tn/paid';
  const shop = standIn({ orders: [pending()], payments: { [REF]: payment() }, returnUrl });
  const { answered } = await logged(t, async () => route(await event('notification.json'), shop.open));
  const forged = request('GET', '/webhooks/konnect', { query: { payment_ref: 'bbbbbbbbbbbbbbbbbbbbbbbb' } });
  const { answered: elsewhere } = await logged(t, () => route(forged, shop.open));

  assert.deepEqual([answered.statusCode, answered.headers.location], [303, `https://shop.example.tn/paid?order=${ID}`]);
  assert.deepEqual([elsewhere.statusCode, elsewhere.headers.location], [303, 'https://shop.example.tn/paid']);
});

test("GET /orders/<id> says the order as kept, whatever its address's parameters say", async (t) => {
  const shop = standIn({ orders: [pending()], payments: { [REF]: payment({ status: 'pending' }) } });
  const read = request('GET', `/orders/${ID}`, { query: { status: 'paid', payment_ref: REF } });
  const { answered } = await logged(t, () => route(read, shop.open));

  assert.deepEqual([answered.statusCode, JSON.parse(answered.body).status, shop.asked], [200, 'pending', [REF]]);

  // Paid at Konnect, its notification lost: asking again pays it.
  const paidThen = standIn({ orders: [pending()], payments: { [REF]: payment() } });
  const { answered: again } = await logged(t, () => route(read, paidThen.open));
  assert.deepEqual([JSON.parse(again.body).status, paidThen.asked], ['paid', [REF]]);

  // Paid: read as kept, Konnect not asked again.
  const { answered: last } = await logged(t, () => route(read, paidThen.open));
  assert.deepEqual([JSON.parse(last.body).status, paidThen.asked], ['paid', [REF]]);
});

test('an order no one has is 404; a path without a route 404, a method its route lacks 405 with Allow', async () => {
  const shop = standIn();
  const answers = [
    await route(request('GET', '/orders/0b6e1d4a-8c2f-4f3e-9a7b-000000000000'), shop.open),
    await route(request('GET', '/payments'), shop.open),
    await route(request('POST', '/webhooks/konnect'), shop.open),
    await route(request('DELETE', `/orders/${ID}`), shop.open),
  ];

  assert.deepEqual(
    answers.map((answered) => [answered.statusCode, answered.headers.allow]),
    [[404, undefined], [404, undefined], [405, 'GET'], [405, 'GET']],
  );
});

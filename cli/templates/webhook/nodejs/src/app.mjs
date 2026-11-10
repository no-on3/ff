// {{name}}'s payments, at its function's URL: orders paid through Konnect, and Konnect's notifications received right.
//   POST /orders             {"amount": 12500, "description": "…"}: the payment made at Konnect, 201 with the order
//                            and its payUrl, the page where the payer pays
//   GET  /orders/<id>        the order as kept here, Konnect asked again while it is pending
//   GET  /webhooks/konnect   ?payment_ref=…: Konnect's notification, which the payer's browser follows too
// A notification says which payment to ask about, and nothing in it is believed: anyone can call that address, with
// any reference. Each is kept as it came; then the payment is asked of Konnect, with the shop's key, and its order paid
// when Konnect says it is completed, for this order, its amount and its currency; once, however many notifications
// come. The address the payer's browser comes back to says nothing either: the order, read here, says it.
// The event is Lambda's URL event (version 2.0), the same on FF and on AWS Lambda. template.yaml gives the settings,
// KONNECT_API_URL, KONNECT_WALLET_ID and RETURN_URL; the two secrets stay out of it: KONNECT_API_KEY and DATABASE_URL.
import { randomUUID } from 'node:crypto';

/** A request that can't be taken: its answer is 400 with the message. */
class Invalid extends Error {}

/** Konnect didn't answer, or refused: nothing is paid, and a payment that wasn't made is said so. */
export class Unanswered extends Error {}

// Konnect's amounts are whole: millimes for dinars, cents for euros and dollars, which it takes too.
const CURRENCY = 'TND';
const MOST = 100_000_000;
// A payment's reference as Konnect writes them, letters and digits: a notification naming none is kept, and no more.
const REFERENCE = /^[0-9A-Za-z_-]{1,64}$/;

/** The routes: a method, a path, and what answers them, given the shop and the path's ID. */
const ROUTES = [
  ['POST', /^\/orders\/?$/, ({ shop, event }) => checkout(shop, event)],
  ['GET', /^\/orders\/([0-9a-f-]{36})$/, ({ shop, id }) => order(shop, id)],
  ['GET', /^\/webhooks\/konnect\/?$/, ({ shop, event }) => notified(shop, event)],
];

export async function handler(event) {
  return route(event, shop);
}

/** The request's answer, the shop given by `open` when its route needs it: the tests give their own. */
export async function route(event, open) {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const paths = ROUTES.filter(([, pattern]) => pattern.test(path));
  if (paths.length === 0) return answer(404, { message: `No route for ${path}` });
  const found = paths.find(([verb]) => verb === method);
  if (!found) {
    const allowed = paths.map(([verb]) => verb).join(', ');
    return answer(405, { message: `${path} takes ${allowed}, not ${method}` }, { allow: allowed });
  }
  const [, pattern, run] = found;
  try {
    return await run({ shop: await open(), event, id: path.match(pattern)[1] });
  } catch (error) {
    if (error instanceof Invalid) return answer(400, { message: error.message });
    throw error;
  }
}

/** POST /orders: the payment made at Konnect first, then the order kept with its reference. */
async function checkout({ store, konnect }, event) {
  // A shop's amount comes from its own prices, never from the payer's request: here is where it reckons it.
  const { amount, description } = orderOf(bodyOf(event));
  const id = randomUUID();
  let payment;
  try {
    const webhook = `${addressOf(event)}/webhooks/konnect`;
    payment = await konnect.initPayment({ amount, description, orderId: id, webhook });
  } catch (error) {
    if (!(error instanceof Unanswered)) throw error;
    log({ unpaid: id, why: `no payment made: Konnect ${error.message}` });
    return answer(502, { message: 'Konnect made no payment: try again' });
  }
  const kept = await store.create({ id, amount, currency: CURRENCY, description, paymentRef: payment.paymentRef });
  log({ ordered: id, amount, paymentRef: payment.paymentRef });
  return answer(201, { ...kept, payUrl: payment.payUrl }, { location: `/orders/${id}` });
}

/** GET /orders/<id>: the order as kept, Konnect asked again while it is pending, as a notification may not come. */
async function order(shop, id) {
  const found = await shop.store.order(id);
  if (!found) return answer(404, { message: `No order ${id}` });
  if (found.status === 'pending') await settle(shop, found);
  return answer(200, await shop.store.order(id));
}

/** GET /webhooks/konnect: the notification kept as it came, then its payment asked of Konnect. */
async function notified(shop, event) {
  const reference = event.queryStringParameters?.payment_ref ?? null;
  await shop.store.keep({
    provider: 'konnect',
    paymentRef: reference,
    query: event.rawQueryString ?? '',
    sourceIp: event.requestContext.http.sourceIp ?? null,
    userAgent: event.headers?.['user-agent'] ?? null,
  });
  if (reference === null || !REFERENCE.test(reference)) {
    log({ left: reference, why: 'no payment reference' });
    return answer(400, { message: 'A notification names its payment: ?payment_ref=<its reference>' });
  }
  const found = await shop.store.orderByReference(reference);
  if (!found) log({ left: reference, why: 'no order has this payment' });
  else if (found.status === 'paid') log({ already: found.id, paymentRef: reference });
  else await settle(shop, found);
  // The same answer whatever was found, for Konnect's call and for the payer's browser alike.
  if (!shop.returnUrl) return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'Received' };
  const back = new URL(shop.returnUrl);
  if (found) back.searchParams.set('order', found.id);
  return { statusCode: 303, headers: { location: back.href } };
}

/** Asks Konnect about the order's payment, and pays the order if Konnect says it is paid: once, by its reference. */
async function settle({ store, konnect }, kept) {
  let payment;
  try {
    payment = await konnect.payment(kept.paymentRef);
  } catch (error) {
    if (!(error instanceof Unanswered)) throw error;
    log({ left: kept.paymentRef, why: `Konnect ${error.message}` });
    return;
  }
  const why = unpaid(payment, kept);
  if (why) {
    log({ left: kept.paymentRef, why });
    return;
  }
  if (await store.paid(kept.id, kept.paymentRef)) {
    // Here a shop does what a payment is for, its order sent, its receipt: this runs once for each order paid.
    log({ paid: kept.id, amount: kept.amount, paymentRef: kept.paymentRef });
  } else {
    log({ already: kept.id, paymentRef: kept.paymentRef });
  }
}

/** Why Konnect's payment doesn't pay the order, or null when it does. */
function unpaid(payment, kept) {
  if (payment?.status !== 'completed') return `Konnect says ${payment?.status ?? 'nothing'}`;
  if (payment.orderId !== kept.id) return `Konnect's payment is for the order ${payment.orderId}`;
  if (payment.amount !== kept.amount || payment.token !== kept.currency) {
    return `Konnect's payment is ${payment.amount} ${payment.token}, the order ${kept.amount} ${kept.currency}`;
  }
  return null;
}

function bodyOf(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Invalid('The body is JSON: {"amount": <millimes>, "description": "…"}');
  }
}

function orderOf(body) {
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const amount = body?.amount;
  const whole = Number.isInteger(amount) && amount >= 1 && amount <= MOST;
  if (!whole || description.length === 0 || description.length > 200) {
    throw new Invalid(
      `An order is {"amount": <millimes>, "description": "…"}: its amount a whole number of millimes, 1 to ${MOST}, ` +
        'its description 1 to 200 characters',
    );
  }
  return { amount, description };
}

/** The function's own address, as its caller reached it: Konnect calls back there. */
function addressOf(event) {
  const host = event.headers?.host ?? event.requestContext.domainName;
  // Here, ff local start answers plain http; elsewhere the URL is https, which a proxy before it may say.
  const local = /^(localhost|127\.0\.0\.1|[^:]+\.localhost)(:\d+)?$/.test(host);
  const scheme = event.headers?.['x-forwarded-proto']?.split(',')[0].trim() || (local ? 'http' : 'https');
  return `${scheme}://${host}`;
}

function log(line) {
  console.log(JSON.stringify(line));
}

function answer(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

// The shop, made at the instance's first call that needs it and kept for the calls after, as an instance takes one
// call at a time: the database, its tables made then if they aren't there, and Konnect.
let ready;

function shop() {
  ready ??= openShop().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

async function openShop() {
  return { store: await database(), konnect: konnect(), returnUrl: process.env.RETURN_URL ?? '' };
}

const ORDER = `id, amount, currency, description, payment_ref AS "paymentRef", status,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
  to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "paidAt"`;

async function database() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set: the database is the function's secret, see README.md");
  }
  // Loaded here, so that the tests run without it installed.
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
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
      received_at timestamptz NOT NULL DEFAULT now())`);
  const rows = async (text, values) => (await pool.query(text, values)).rows;
  return {
    keep: async ({ provider, paymentRef, query, sourceIp, userAgent }) => {
      await rows(
        'INSERT INTO notifications (provider, payment_ref, query, source_ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [provider, paymentRef, query, sourceIp, userAgent],
      );
    },
    create: async ({ id, amount, currency, description, paymentRef }) => {
      const [kept] = await rows(
        `INSERT INTO orders (id, amount, currency, description, payment_ref) VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ORDER}`,
        [id, amount, currency, description, paymentRef],
      );
      return kept;
    },
    order: async (id) => (await rows(`SELECT ${ORDER} FROM orders WHERE id = $1`, [id]))[0] ?? null,
    orderByReference: async (reference) =>
      (await rows(`SELECT ${ORDER} FROM orders WHERE payment_ref = $1`, [reference]))[0] ?? null,
    // One statement, so that two notifications at once pay the order once: the second finds it paid.
    paid: async (id, reference) =>
      (
        await rows(
          `UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1 AND payment_ref = $2 AND status = 'pending'
           RETURNING id`,
          [id, reference],
        )
      ).length === 1,
  };
}

/** Konnect's API, as its documentation describes it: the key in x-api-key, JSON both ways. */
function konnect() {
  const api = (process.env.KONNECT_API_URL ?? '').replace(/\/+$/, '');
  const key = process.env.KONNECT_API_KEY;
  const wallet = process.env.KONNECT_WALLET_ID;
  for (const [name, value] of [
    ['KONNECT_API_URL', api],
    ['KONNECT_API_KEY', key],
    ['KONNECT_WALLET_ID', wallet],
  ]) {
    if (!value) throw new Error(`${name} is not set: Konnect's settings are the function's, see README.md`);
  }
  async function call(method, path, body) {
    let response;
    try {
      response = await fetch(`${api}${path}`, {
        method,
        headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new Unanswered(`didn't answer: ${error.cause?.message ?? error.message}`);
    }
    if (!response.ok) throw new Unanswered(`answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  }
  return {
    // POST /payments/init-payment: the amount, the wallet it goes to, the order's ID and the address to notify.
    initPayment: async ({ amount, description, orderId, webhook }) => {
      const made = await call('POST', '/payments/init-payment', {
        receiverWalletId: wallet,
        token: CURRENCY,
        amount,
        type: 'immediate',
        description,
        orderId,
        webhook,
      });
      return { payUrl: made.payUrl, paymentRef: made.paymentRef };
    },
    // GET /payments/<reference>: the payment as Konnect has it, its status completed or pending.
    payment: async (reference) => (await call('GET', `/payments/${encodeURIComponent(reference)}`)).payment,
  };
}

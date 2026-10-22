// A small app on FF, as it would run on AWS Lambda: orders taken at a web address and kept in
// PostgreSQL, and a report each night. One package, two functions:
//   orders-api      handler index.http     its function URL: POST /orders, GET /orders
//   orders-nightly  handler index.nightly  a schedule, cron(0 2 * * ? *): yesterday's orders counted,
//                                          those older than 90 days removed
// Each reads DATABASE_URL, a secret: ff secrets set orders-api DATABASE_URL
const { Pool } = require('pg');

// One connection per instance, made at its first call and kept for the calls after, as an
// instance takes one call at a time.
let pool;
let ready;

function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set: ff secrets set <function> DATABASE_URL');
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  ready ??= pool.query(`CREATE TABLE IF NOT EXISTS orders (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item text NOT NULL,
    quantity integer NOT NULL CHECK (quantity > 0),
    created_at timestamptz NOT NULL DEFAULT now())`);
  return ready.then(() => pool);
}

const answer = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// AWS Lambda's event for function URLs in, the response out.
exports.http = async (event) => {
  const { method, path } = event.requestContext.http;
  const db = await database();
  if (method === 'POST' && path === '/orders') {
    const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString() : (event.body ?? '');
    let order;
    try {
      order = JSON.parse(text);
    } catch {
      return answer(400, { message: 'The body must be JSON' });
    }
    if (typeof order?.item !== 'string' || order.item === '' || !Number.isInteger(order.quantity) || order.quantity < 1) {
      return answer(400, { message: 'An order is {"item": "<what>", "quantity": <a whole number above 0>}' });
    }
    const { rows } = await db.query(
      'INSERT INTO orders (item, quantity) VALUES ($1, $2) RETURNING id, item, quantity, created_at',
      [order.item, order.quantity],
    );
    return answer(201, rows[0]);
  }
  if (method === 'GET' && path === '/orders') {
    const { rows } = await db.query('SELECT id, item, quantity, created_at FROM orders ORDER BY id DESC LIMIT 20');
    return answer(200, rows);
  }
  return answer(404, { message: 'POST /orders or GET /orders' });
};

// EventBridge's Scheduled Event in: the day before its time, counted; what is older than 90 days, removed.
exports.nightly = async (event) => {
  const db = await database();
  const end = new Date(event.time ?? Date.now());
  end.setUTCHours(0, 0, 0, 0);
  const { rows } = await db.query(
    `SELECT count(*)::int AS orders, coalesce(sum(quantity), 0)::int AS items FROM orders
      WHERE created_at >= $1::timestamptz - interval '1 day' AND created_at < $1::timestamptz`,
    [end.toISOString()],
  );
  const removed = await db.query("DELETE FROM orders WHERE created_at < $1::timestamptz - interval '90 days'", [end.toISOString()]);
  const report = { day: new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10), ...rows[0], removed: removed.rowCount };
  console.log(`report ${JSON.stringify(report)}`);
  return report;
};

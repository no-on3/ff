// A small app on FF, as it would run on AWS Lambda: orders taken at a web address and kept in PostgreSQL, each
// order's receipt made in the background and kept in a bucket, and a report each night. One package, three functions:
//   orders-api       handler index.http      its function URL: POST /orders, GET /orders, GET /orders/<id>/receipt
//   orders-receipts  handler index.receipts  reads the queue of new orders (ff event-sources add): each one's receipt
//   orders-nightly   handler index.nightly   a schedule, cron(0 2 * * ? *): yesterday's orders counted, those older
//                                            than 90 days removed, with their receipts
// orders-api and orders-nightly read DATABASE_URL, a secret (ff db create orders --secret-for orders-api). A new
// order goes to the queue RECEIPTS_QUEUE names, for orders-receipts to write its receipt to the bucket RECEIPTS_BUCKET
// names, where orders-api reads it back; without the queue, orders-api writes it itself, and without the bucket,
// orders go without receipts. The
// key, region and endpoints are the function's own, in its environment, as AWS Lambda gives a function its role's:
// new S3Client({}) and new SQSClient({}) need nothing more, on FF as on AWS.
const { Pool } = require('pg');
const { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { GetQueueUrlCommand, SendMessageCommand, SQSClient } = require('@aws-sdk/client-sqs');

// One connection per instance, made at its first call and kept for the calls after, as an
// instance takes one call at a time.
let pool;
let ready;
let s3;
let sqs;
let queueUrl;

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

const bucket = () => process.env.RECEIPTS_BUCKET;
const queue = () => process.env.RECEIPTS_QUEUE;
const receiptKey = (id) => `receipts/${id}.txt`;
const receipt = (order) => `Order ${order.id}\n${order.quantity} × ${order.item}\n${new Date(order.created_at).toISOString()}\n`;
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
    const made = rows[0];
    // The order is kept first: a receipt that can't be asked for, or written, leaves it, said in the answer and the log.
    if (queue()) {
      sqs ??= new SQSClient({});
      try {
        // The queue found by its name, as on AWS: its URL is the endpoint's this function reaches.
        queueUrl ??= (await sqs.send(new GetQueueUrlCommand({ QueueName: queue() }))).QueueUrl;
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(made) }));
        return answer(201, { ...made, receipt: 'queued' });
      } catch (error) {
        console.error(`order ${made.id}: its receipt could not be asked for: ${error.name}: ${error.message}`);
        return answer(201, { ...made, receipt: null });
      }
    }
    if (!bucket()) return answer(201, made);
    s3 ??= new S3Client({});
    try {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket(), Key: receiptKey(made.id), Body: receipt(made), ContentType: 'text/plain; charset=utf-8' }),
      );
      return answer(201, { ...made, receipt: `s3://${bucket()}/${receiptKey(made.id)}` });
    } catch (error) {
      console.error(`order ${made.id}: its receipt could not be written: ${error.name}: ${error.message}`);
      return answer(201, { ...made, receipt: null });
    }
  }
  if (method === 'GET' && path === '/orders') {
    const { rows } = await db.query('SELECT id, item, quantity, created_at FROM orders ORDER BY id DESC LIMIT 20');
    return answer(200, rows);
  }
  const wanted = method === 'GET' && /^\/orders\/([0-9]+)\/receipt$/.exec(path);
  if (wanted) {
    if (!bucket()) return answer(404, { message: 'RECEIPTS_BUCKET is not set: no receipt is kept' });
    s3 ??= new S3Client({});
    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: receiptKey(wanted[1]) }));
      return { statusCode: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: await object.Body.transformToString() };
    } catch (error) {
      if (error.name === 'NoSuchKey') return answer(404, { message: `No receipt for order ${wanted[1]}` });
      throw error;
    }
  }
  return answer(404, { message: 'POST /orders, GET /orders or GET /orders/<id>/receipt' });
};

// SQS's event in, as Lambda gives it to a function that reads a queue: each record a new order, whose receipt goes to
// the bucket. A receipt that can't be written names its message in batchItemFailures, so that it alone comes back
// once the queue's visibility timeout ends, and goes to the queue's dead-letter queue if it never can. A message
// received twice writes the same receipt again.
exports.receipts = async (event) => {
  if (!bucket()) throw new Error('RECEIPTS_BUCKET is not set: ff env set <function> RECEIPTS_BUCKET=<name>');
  s3 ??= new S3Client({});
  const batchItemFailures = [];
  for (const record of event.Records) {
    try {
      const order = JSON.parse(record.body);
      await s3.send(
        new PutObjectCommand({ Bucket: bucket(), Key: receiptKey(order.id), Body: receipt(order), ContentType: 'text/plain; charset=utf-8' }),
      );
    } catch (error) {
      console.error(`message ${record.messageId}: its receipt could not be written: ${error.name}: ${error.message}`);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};

// EventBridge's Scheduled Event in: the day before its time, counted; what is older than 90 days, removed, the
// orders and their receipts.
exports.nightly = async (event) => {
  const db = await database();
  const end = new Date(event.time ?? Date.now());
  end.setUTCHours(0, 0, 0, 0);
  const { rows } = await db.query(
    `SELECT count(*)::int AS orders, coalesce(sum(quantity), 0)::int AS items FROM orders
      WHERE created_at >= $1::timestamptz - interval '1 day' AND created_at < $1::timestamptz`,
    [end.toISOString()],
  );
  const removed = await db.query("DELETE FROM orders WHERE created_at < $1::timestamptz - interval '90 days' RETURNING id", [end.toISOString()]);
  let receipts = 0;
  if (bucket() && removed.rows.length > 0) {
    s3 ??= new S3Client({});
    // DeleteObjects takes 1,000 keys at most, as on S3.
    for (let at = 0; at < removed.rows.length; at += 1000) {
      const keys = removed.rows.slice(at, at + 1000).map((row) => ({ Key: receiptKey(row.id) }));
      const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys, Quiet: false } }));
      receipts += deleted.Deleted?.length ?? 0;
    }
  }
  const report = { day: new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10), ...rows[0], removed: removed.rowCount, receipts };
  console.log(`report ${JSON.stringify(report)}`);
  return report;
};

#!/usr/bin/env node
// Where step 3's queue keeps its messages, measured: pgmq installed as plain SQL (its own schema, no extension), against
// FF's own table in pgmq's shape (one table for every queue, claimed FOR UPDATE SKIP LOCKED), on FF's PostgreSQL. The
// same work for each: messages sent one at a time and ten at a time, as SendMessage and SendMessageBatch would; several
// consumers claiming ten at a time with a visibility timeout, then deleting them, as ReceiveMessage and DeleteMessage
// would; a consumer that stops without deleting; many queues. One JSON line per measure, {design, measure, value,
// unit, note}, for storage.sh.
//   MODULES=<a folder whose node_modules has pg> DATABASE_URL=postgres://… [MESSAGES=20000] [CONSUMERS=4] [QUEUES=200] node storage.mjs
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const { Pool } = require('pg');
const MESSAGES = Number(process.env.MESSAGES ?? 20000);
const CONSUMERS = Number(process.env.CONSUMERS ?? 4);
const SENDERS = Number(process.env.SENDERS ?? 4);
const QUEUES = Number(process.env.QUEUES ?? 200);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Math.max(CONSUMERS, SENDERS) + 2 });

const emit = (design, measure, value, unit, note) => console.log(JSON.stringify({ design, measure, value, unit, ...(note ? { note } : {}) }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const body = (n) => JSON.stringify({ order: n, item: 'harissa', quantity: 2, note: 'x'.repeat(200) });
async function timed(work) {
  const started = process.hrtime.bigint();
  const result = await work();
  return { seconds: Number(process.hrtime.bigint() - started) / 1e9, result };
}
/** Runs `count` jobs over `workers` connections at once, each job on its own transaction. */
async function inParallel(count, workers, job) {
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let n = next++; n < count; n = next++) await job(n);
    }),
  );
}

/** pgmq's functions, as its SQL file installed them: a table per queue, pgmq.q_<name>. */
const pgmq = {
  name: 'pgmq',
  async setUp() {
    await pool.query("SELECT pgmq.create('bench')");
  },
  async tearDown() {
    await pool.query("SELECT pgmq.drop_queue('bench')");
  },
  send: (n) => pool.query("SELECT pgmq.send('bench', $1::jsonb)", [body(n)]),
  sendBatch: (bodies) => pool.query("SELECT pgmq.send_batch('bench', $1::jsonb[])", [bodies]),
  async claim(client, vt, limit) {
    const { rows } = await client.query('SELECT msg_id::text AS id, read_ct AS count, message FROM pgmq.read($1, $2, $3)', ['bench', vt, limit]);
    return rows.map((row) => ({ id: row.id, count: row.count, order: row.message.order }));
  },
  delete: (client, ids) => client.query("SELECT pgmq.delete('bench', $1::bigint[])", [ids]),
  waiting: async () => Number((await pool.query('SELECT count(*) FROM pgmq.q_bench')).rows[0].count),
  async manyQueues(count) {
    for (let n = 0; n < count; n++) await pool.query('SELECT pgmq.create($1)', [`q${n}`]);
  },
  async dropMany(count) {
    for (let n = 0; n < count; n++) await pool.query('SELECT pgmq.drop_queue($1)', [`q${n}`]);
  },
};

/** FF's own table in pgmq's shape: every queue's messages in one table, a queue an ID. */
const own = {
  name: 'own',
  async setUp() {
    await pool.query(`CREATE TABLE IF NOT EXISTS queue_messages (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      queue_id integer NOT NULL,
      body text NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      visible_at timestamptz NOT NULL DEFAULT now(),
      receive_count integer NOT NULL DEFAULT 0)`);
    await pool.query('CREATE INDEX IF NOT EXISTS queue_messages_next ON queue_messages (queue_id, visible_at, id)');
  },
  async tearDown() {
    await pool.query('DROP TABLE queue_messages');
  },
  send: (n) => pool.query('INSERT INTO queue_messages (queue_id, body) VALUES (1, $1)', [body(n)]),
  sendBatch: (bodies) => pool.query('INSERT INTO queue_messages (queue_id, body) SELECT 1, unnest($1::text[])', [bodies]),
  async claim(client, vt, limit) {
    const { rows } = await client.query(
      `UPDATE queue_messages SET visible_at = now() + make_interval(secs => $1), receive_count = receive_count + 1
        WHERE id IN (SELECT id FROM queue_messages WHERE queue_id = 1 AND visible_at <= now() ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING id::text AS id, receive_count AS count, body`,
      [vt, limit],
    );
    return rows.map((row) => ({ id: row.id, count: row.count, order: JSON.parse(row.body).order }));
  },
  delete: (client, ids) => client.query('DELETE FROM queue_messages WHERE id = ANY($1::bigint[])', [ids]),
  waiting: async () => Number((await pool.query('SELECT count(*) FROM queue_messages')).rows[0].count),
  async manyQueues() {
    // A queue is a row elsewhere and an ID here: nothing to make.
  },
  async dropMany() {},
};

async function measure(design) {
  await design.setUp();

  // One message a transaction, from several senders at once: SendMessage.
  const single = await timed(() => inParallel(MESSAGES, SENDERS, (n) => design.send(n)));
  emit(design.name, 'send one at a time', Math.round(MESSAGES / single.seconds), 'messages/s', `${SENDERS} senders`);

  // Every message claimed by one consumer only, ten at a time, then deleted: ReceiveMessage and DeleteMessage.
  const seen = new Map();
  const consumed = await timed(() =>
    Promise.all(
      Array.from({ length: CONSUMERS }, async () => {
        const client = await pool.connect();
        try {
          for (;;) {
            const batch = await design.claim(client, 30, 10);
            if (batch.length === 0) break;
            for (const message of batch) seen.set(message.order, (seen.get(message.order) ?? 0) + 1);
            await design.delete(
              client,
              batch.map((message) => message.id),
            );
          }
        } finally {
          client.release();
        }
      }),
    ),
  );
  const twice = [...seen.values()].filter((count) => count > 1).length;
  emit(design.name, 'claim ten and delete', Math.round(MESSAGES / consumed.seconds), 'messages/s', `${CONSUMERS} consumers`);
  emit(design.name, 'each message to one consumer', seen.size === MESSAGES && twice === 0, 'boolean', `${seen.size} delivered, ${twice} twice`);

  // Ten a transaction: SendMessageBatch.
  const batches = Math.ceil(MESSAGES / 10);
  const batched = await timed(() =>
    inParallel(batches, SENDERS, (n) => design.sendBatch(Array.from({ length: 10 }, (_, k) => body(n * 10 + k)))),
  );
  emit(design.name, 'send ten at a time', Math.round((batches * 10) / batched.seconds), 'messages/s', `${SENDERS} senders`);
  // Emptied again for what follows.
  const client = await pool.connect();
  try {
    for (let batch = await design.claim(client, 30, 100); batch.length > 0; batch = await design.claim(client, 30, 100)) {
      await design.delete(
        client,
        batch.map((message) => message.id),
      );
    }
  } finally {
    client.release();
  }

  // A consumer that stops between its claim and its delete: the messages come back when their visibility timeout ends.
  for (let n = 0; n < 10; n++) await design.send(1_000_000 + n);
  const first = await pool.connect();
  const second = await pool.connect();
  try {
    const claimed = await design.claim(first, 2, 10);
    first.release(true);
    const meanwhile = await design.claim(second, 2, 10);
    await sleep(2500);
    const again = await design.claim(second, 30, 10);
    emit(
      design.name,
      'a stopped consumer\'s messages come back after their timeout',
      claimed.length === 10 && meanwhile.length === 0 && again.length === 10 && again.every((message) => message.count === 2),
      'boolean',
      `${claimed.length} claimed, ${meanwhile.length} seen meanwhile, ${again.length} again, received ${[...new Set(again.map((message) => message.count))].join(',')} times`,
    );
    await design.delete(
      second,
      again.map((message) => message.id),
    );
  } finally {
    second.release();
  }

  // Many queues: what each costs to make, and what the database then holds.
  const before = Number((await pool.query("SELECT count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pgmq', 'public'))")).rows[0].count);
  const made = await timed(() => design.manyQueues(QUEUES));
  const after = Number((await pool.query("SELECT count(*) FROM pg_class WHERE relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('pgmq', 'public'))")).rows[0].count);
  emit(design.name, `${QUEUES} queues made`, Number(made.seconds.toFixed(2)), 's', `${after - before} relations more (tables, indexes, sequences)`);
  await design.dropMany(QUEUES);

  emit(design.name, 'left waiting', await design.waiting(), 'messages');
  await design.tearDown();
}

const designs = (process.env.DESIGNS ?? 'pgmq,own').split(',');
try {
  for (const name of designs) await measure(name === 'pgmq' ? pgmq : own);
} finally {
  await pool.end();
}

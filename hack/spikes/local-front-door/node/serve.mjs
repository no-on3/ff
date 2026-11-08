#!/usr/bin/env node
// The other side of the measure: the backend's own S3 and SQS front doors, as BE/dist builds them, run in Node.js
// without NestJS and without PostgreSQL. What they are given in place of Nest's injection is below, each the least
// that lets the six operations through: the settings; one key, one account and one plan; the buckets and queues named;
// the queues' messages in memory, as CustomerQueues keeps them in SQL; nothing counted, audited or limited. The S3
// front door is a proxy: its objects go to the store, SeaweedFS, whose address and keys are given.
//   node serve.mjs --dist BE/dist --account 123456789012 --key id:secret --store http://127.0.0.1:8333 \
//     --store-key id:secret [--host localhost] [--bucket name]... [--queue name]...
// Prints {"s3": <port>, "sqs": <port>} once both listen; with FF_SPIKE_MODULES=<file>, writes there every module loaded.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
  options: {
    dist: { type: 'string' },
    account: { type: 'string' },
    key: { type: 'string' },
    store: { type: 'string' },
    'store-key': { type: 'string' },
    host: { type: 'string', default: 'localhost' },
    bucket: { type: 'string', multiple: true, default: [] },
    queue: { type: 'string', multiple: true, default: [] },
  },
});
const require = createRequire(`${resolve(flags.dist)}/`);
const { S3FrontDoor } = require('./storage/front-door.js');
const { StoreClient } = require('./storage/store-client.js');
const { SqsFrontDoor } = require('./queues/sqs-front-door.js');
const { SqsOperations } = require('./queues/sqs-operations.js');
const { DEFAULT_SETTINGS } = require('./queues/sqs-attributes.js');
const { AccountStatus } = require('./accounts/entities/account.entity.js');

const REGION = 'tn-tunis-1';
const [keyId, secret] = flags.key.split(':');
const [storeKeyId, storeSecret] = flags['store-key'].split(':');
const accountId = flags.account;
const store = new URL(flags.store);

/** A port free now, for the SQS front door, whose queues' URLs name it before it listens. */
const freePort = () =>
  new Promise((done, fail) => {
    const probe = createServer().once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
const sqsPort = await freePort();
const sqsBase = `http://${flags.host}:${sqsPort}`;

const settings = {
  'storage.base': `http://${flags.host}`,
  'storage.region': REGION,
  objectStore: { endPoint: store.hostname, port: Number(store.port), useSSL: false, accessKey: storeKeyId, secretKey: storeSecret },
  sqs: { base: sqsBase, region: REGION },
};
const config = {
  getOrThrow(name) {
    if (!(name in settings)) throw new Error(`No setting ${name}`);
    return settings[name];
  },
};

// The account's one key, which reaches all its buckets and queues, as a key that names none does.
const key = { id: keyId, accountId, name: 'local', functionId: null, buckets: null, queues: null, functions: null, functionAccess: null, readOnly: false, secret };
const account = { id: accountId, status: AccountStatus.ACTIVE, planId: 'local', storageDisabledAt: null, bucketStorageNotice: null };
const plan = {
  name: 'local',
  limits: { storageRequestsPerSecond: 1e9, queueRequestsPerSecond: 1e9, maxObjectMb: 5 * 1024, bucketStorageMb: 1e9, queueStorageMb: 1e9, queues: 1e9, buckets: 1e9 },
};
const buckets = new Map(
  flags.bucket.map((name) => [
    name,
    { id: randomUUID(), accountId, name, storeName: `local-${name}`, status: 'active', notifications: null, website: null, policy: null, publicAccessBlock: null, createdAt: new Date() },
  ]),
);
const directory = {
  key: async (id) => (id === key.id ? key : null),
  touch() {},
  account: async (id) => (id === accountId ? account : null),
  bucket: async (name) => buckets.get(name) ?? null,
  bucketsOf: async () => [...buckets.values()],
};
const plans = { get: async () => plan };
const credit = { admit: async () => undefined };
const throttler = { increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }) };
const uncounted = { count() {} };
const keyUses = { note() {} };

/** The queues' messages, as CustomerQueues keeps them in queue_messages: hidden for their delay, then for each receive's visibility. */
class MemoryQueues {
  queues = new Map();
  rows = [];
  next = 0;
  arrivals = new EventEmitter();

  constructor(names) {
    for (const name of names) {
      this.queues.set(name, { id: randomUUID(), accountId, name, kind: 'customer', functionId: null, sizeBytes: '0', ...DEFAULT_SETTINGS, createdAt: new Date(), updatedAt: new Date() });
    }
  }

  async find(owner, name) {
    const queue = this.queues.get(name);
    return queue && queue.accountId === owner ? queue : null;
  }

  async send(queue, messages, now) {
    for (const message of messages) {
      this.rows.push({
        id: String(++this.next),
        queueId: queue.id,
        messageId: message.messageId,
        body: message.body,
        meta: message.meta,
        sizeBytes: message.sizeBytes,
        receiveCount: 0,
        firstReceivedAt: null,
        sentAt: now,
        visibleAt: now.getTime() + message.delaySeconds * 1000,
        expiresAt: now.getTime() + queue.messageRetentionSeconds * 1000,
      });
    }
    this.arrivals.emit('message', queue.id);
  }

  async receive(queue, max, visibility, now) {
    const at = now.getTime();
    this.rows = this.rows.filter((row) => row.expiresAt > at);
    return this.rows
      .filter((row) => row.queueId === queue.id && row.visibleAt <= at)
      .slice(0, max)
      .map((row) => {
        row.receiveCount += 1;
        row.firstReceivedAt ??= now;
        row.visibleAt = at + visibility * 1000;
        const { id, messageId, body, meta, sentAt, receiveCount, firstReceivedAt, sizeBytes } = row;
        return { id, messageId, body, meta, sentAt, receiveCount, firstReceivedAt, sizeBytes };
      });
  }

  async deleteMessages(queue, receipts) {
    const named = (row) => receipts.some((receipt) => receipt.id === row.id && receipt.receiveCount === row.receiveCount && receipt.messageId === row.messageId);
    this.rows = this.rows.filter((row) => row.queueId !== queue.id || !named(row));
  }

  bytesOf(owner) {
    const ids = new Set([...this.queues.values()].filter((queue) => queue.accountId === owner).map((queue) => queue.id));
    return this.rows.filter((row) => ids.has(row.queueId)).reduce((sum, row) => sum + row.sizeBytes, 0);
  }
}
const queues = new MemoryQueues(flags.queue);
const queueStore = { accountBytes: async (owner) => queues.bytesOf(owner) };
// QueueEvents' wait, told of a message as PostgreSQL's NOTIFY tells it.
const events = {
  wait: (queueId, ms, signal) =>
    new Promise((done) => {
      if (signal?.aborted) return done();
      const finish = () => {
        clearTimeout(timer);
        queues.arrivals.off('message', arrived);
        signal?.removeEventListener('abort', finish);
        done();
      };
      const arrived = (id) => id === queueId && finish();
      const timer = setTimeout(finish, Math.max(0, ms));
      queues.arrivals.on('message', arrived);
      signal?.addEventListener('abort', finish);
    }),
};
const audit = { record: async () => undefined };

// The store's buckets, as BucketsService makes them when a customer creates one.
const storeClient = new StoreClient({ endpoint: store.origin, accessKeyId: storeKeyId, secretAccessKey: storeSecret });
for (const bucket of buckets.values()) {
  const { request, response } = storeClient.send('PUT', `/${bucket.storeName}`, '', {});
  request.end();
  const answer = await response;
  answer.resume();
  if (answer.statusCode !== 200 && answer.statusCode !== 409) throw new Error(`The store made no bucket ${bucket.storeName}: ${answer.statusCode}`);
}
storeClient.close();

const operations = new SqsOperations(queues, queueStore, events, audit, uncounted, {}, sqsBase, REGION);
const sqs = new SqsFrontDoor(config, directory, operations, plans, credit, throttler, keyUses);
const s3 = new S3FrontDoor(config, directory, uncounted, plans, credit, throttler, {}, {}, {}, keyUses, {}, {});
const s3Address = await s3.listen(0, '127.0.0.1');
await sqs.listen(sqsPort, '127.0.0.1');
if (process.env.FF_SPIKE_MODULES) writeFileSync(process.env.FF_SPIKE_MODULES, `${Object.keys(require.cache).join('\n')}\n`);
console.log(JSON.stringify({ s3: s3Address.port, sqs: sqsPort }));
const stop = async () => {
  await Promise.all([s3.onModuleDestroy(), sqs.onModuleDestroy()]);
  process.exit(0);
};
process.once('SIGTERM', stop).once('SIGINT', stop);

// The small app's handlers, each path, with PostgreSQL's, Valkey's and AWS's clients stubbed: no database, cache,
// queue, bucket or mail server, and no node_modules. The CLI's end-to-end suite runs the app on FF with all of them
// (hack/cli-e2e.sh); these are the paths it can't take there: a cache that can't be reached, SES or the bucket
// refusing, an address that is none.
//   node --test examples/orders-app/test/handlers.test.js
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { beforeEach, describe, it } = require('node:test');

const app = path.join(__dirname, '..', 'index.js');
let calls;
let world;
let errors;

// The app as a new instance loads it, with these variables.
function instance(env) {
  for (const name of ['DATABASE_URL', 'REDIS_URL', 'RECEIPTS_QUEUE', 'RECEIPTS_BUCKET', 'RECEIPTS_FROM']) delete process.env[name];
  Object.assign(process.env, { DATABASE_URL: 'postgresql://orders@db.example.tn/orders' }, env);
  delete require.cache[app];
  return require(app);
}

const command = (name) =>
  class {
    constructor(input) {
      this.input = input;
    }
    static get name() {
      return name;
    }
  };
const stubs = {
  pg: {
    Pool: class {
      async query(sql, values) {
        if (sql.startsWith('INSERT INTO orders')) {
          const row = { id: world.nextId++, item: values[0], quantity: values[1], email: values[2], created_at: new Date('2026-10-30T09:00:00Z') };
          world.orders.push(row);
          return { rows: [row] };
        }
        if (sql.startsWith('SELECT id, item')) return { rows: world.orders.map(({ email, ...listed }) => listed).reverse() };
        if (sql.includes('count(*)')) return { rows: [{ orders: 1, items: 2 }] };
        if (sql.startsWith('DELETE FROM orders')) return { rows: world.removed.map((id) => ({ id })), rowCount: world.removed.length };
        return { rows: [] };
      }
    },
  },
  '@redis/client': {
    createClient: () => {
      const client = {
        on: () => client,
        connect: async () => {
          calls.push(['cache', 'connect']);
          if (world.cacheDown) throw new Error('connect ECONNREFUSED');
          return client;
        },
        get: async (key) => (calls.push(['cache', `GET ${key}`]), world.kept.get(key) ?? null),
        set: async (key, value, options) => (calls.push(['cache', `SET ${key} EX ${options.expiration.value}`]), world.kept.set(key, value), 'OK'),
        del: async (key) => (calls.push(['cache', `DEL ${key}`]), world.kept.delete(key) ? 1 : 0),
      };
      return client;
    },
  },
  '@aws-sdk/client-s3': {
    S3Client: class {
      async send(sent) {
        calls.push(['s3', sent.constructor.name, sent.input.Key ?? '']);
        if (world.s3Fails) throw Object.assign(new Error('the store is away'), { name: 'ServiceUnavailable' });
        return sent.constructor.name === 'DeleteObjectsCommand' ? { Deleted: sent.input.Delete.Objects } : {};
      }
    },
    PutObjectCommand: command('PutObjectCommand'),
    GetObjectCommand: command('GetObjectCommand'),
    DeleteObjectsCommand: command('DeleteObjectsCommand'),
  },
  '@aws-sdk/client-sqs': {
    SQSClient: class {
      async send(sent) {
        calls.push(['sqs', sent.constructor.name]);
        return sent.constructor.name === 'GetQueueUrlCommand' ? { QueueUrl: 'https://sqs.example.tn/000000000001/new-orders' } : { MessageId: 'm-1' };
      }
    },
    GetQueueUrlCommand: command('GetQueueUrlCommand'),
    SendMessageCommand: command('SendMessageCommand'),
  },
  '@aws-sdk/client-sesv2': {
    SESv2Client: class {
      async send(sent) {
        const { FromEmailAddress, Destination, Content } = sent.input;
        calls.push(['ses', FromEmailAddress, Destination.ToAddresses.join(','), Content.Simple.Subject.Data]);
        if (world.sesFails) throw Object.assign(new Error('Email address is not verified.'), { name: 'MessageRejected' });
        return { MessageId: 'ses-1' };
      }
    },
    SendEmailCommand: command('SendEmailCommand'),
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return stubs[request] ?? load.call(this, request, ...rest);
};
console.error = (line) => errors.push(line);

const http = (method, route, body) => ({ requestContext: { http: { method, path: route } }, body: body === undefined ? undefined : JSON.stringify(body), isBase64Encoded: false });
const json = (answer) => JSON.parse(answer.body);
const made = (kind) => calls.filter((call) => call[0] === kind);

beforeEach(() => {
  calls = [];
  errors = [];
  world = { orders: [], nextId: 1, kept: new Map(), removed: [], cacheDown: false, sesFails: false, s3Fails: false };
});

describe('the API, orders-api', () => {
  it('without a cache lists the orders from the database, X-Cache none, and queues an order for its receipt', async () => {
    const { http: api } = instance({ RECEIPTS_QUEUE: 'new-orders', RECEIPTS_BUCKET: 'shop-receipts' });
    const order = await api(http('POST', '/orders', { item: 'harissa', quantity: 2 }));
    assert.deepEqual([order.statusCode, json(order).receipt, json(order).email], [201, 'queued', null]);
    const list = await api(http('GET', '/orders'));
    assert.deepEqual([list.statusCode, list.headers['x-cache'], json(list).length, 'email' in json(list)[0]], [200, 'none', 1, false]);
    assert.deepEqual(made('cache'), []);
    assert.deepEqual(made('ses'), []);
  });

  it('refuses an address that is none, writing nothing', async () => {
    const { http: api } = instance({ RECEIPTS_QUEUE: 'new-orders' });
    const refused = await api(http('POST', '/orders', { item: 'harissa', quantity: 2, email: 'not an address' }));
    assert.equal(refused.statusCode, 400);
    assert.equal(world.orders.length, 0);
  });

  it('keeps the latest orders in the cache a minute, a miss then a hit, and a new order clears them', async () => {
    const { http: api } = instance({ REDIS_URL: 'rediss://default:pw@cache.example.tn:6400' });
    assert.equal((await api(http('GET', '/orders'))).headers['x-cache'], 'miss');
    assert.equal((await api(http('GET', '/orders'))).headers['x-cache'], 'hit');
    await api(http('POST', '/orders', { item: 'bsissa', quantity: 1 }));
    assert.equal((await api(http('GET', '/orders'))).headers['x-cache'], 'miss');
    assert.deepEqual(
      made('cache').map((call) => call[1]),
      ['connect', 'GET orders:latest', 'SET orders:latest EX 60', 'GET orders:latest', 'DEL orders:latest', 'GET orders:latest', 'SET orders:latest EX 60'],
    );
  });

  it('without a queue writes the receipt itself, then e-mails it from RECEIPTS_FROM', async () => {
    const { http: api } = instance({ RECEIPTS_BUCKET: 'shop-receipts', RECEIPTS_FROM: 'orders@shop.example.tn' });
    const order = await api(http('POST', '/orders', { item: 'bsissa', quantity: 1, email: 'ana@shop.example.tn' }));
    assert.deepEqual([order.statusCode, json(order).receipt, json(order).emailed], [201, 's3://shop-receipts/receipts/1.txt', true]);
    assert.deepEqual(made('ses'), [['ses', 'orders@shop.example.tn', 'ana@shop.example.tn', 'Your receipt, order 1']]);
  });

  it('keeps the order and its receipt when SES refuses the e-mail, saying so in its answer and its log', async () => {
    const { http: api } = instance({ RECEIPTS_BUCKET: 'shop-receipts', RECEIPTS_FROM: 'orders@shop.example.tn' });
    world.sesFails = true;
    const order = await api(http('POST', '/orders', { item: 'makroudh', quantity: 3, email: 'bob@elsewhere.tn' }));
    assert.deepEqual([order.statusCode, json(order).receipt, json(order).emailed], [201, 's3://shop-receipts/receipts/1.txt', false]);
    assert.match(errors.at(-1), /order 1: its receipt could not be e-mailed: MessageRejected/);
  });

  it('answers from the database when the cache can\'t be reached, and tries the cache again at the next call', async () => {
    const { http: api } = instance({ REDIS_URL: 'rediss://default:pw@cache.example.tn:6400' });
    world.cacheDown = true;
    const list = await api(http('GET', '/orders'));
    assert.deepEqual([list.statusCode, list.headers['x-cache']], [200, 'none']);
    assert.match(errors.at(-1), /cache: can't connect: connect ECONNREFUSED/);
    world.cacheDown = false;
    assert.equal((await api(http('GET', '/orders'))).headers['x-cache'], 'miss');
  });
});

describe('the queue\'s reader, orders-receipts', () => {
  const records = [
    { messageId: 'a', body: JSON.stringify({ id: 7, item: 'harissa', quantity: 2, email: 'ana@shop.example.tn', created_at: '2026-10-30T09:00:00Z' }) },
    { messageId: 'b', body: JSON.stringify({ id: 8, item: 'bsissa', quantity: 1, email: null, created_at: '2026-10-30T09:00:00Z' }) },
  ];

  it('writes each receipt, then e-mails those whose order gave an address', async () => {
    const { receipts } = instance({ RECEIPTS_BUCKET: 'shop-receipts', RECEIPTS_FROM: 'orders@shop.example.tn' });
    assert.deepEqual(await receipts({ Records: records }), { batchItemFailures: [] });
    assert.deepEqual(made('s3').map((call) => call[2]), ['receipts/7.txt', 'receipts/8.txt']);
    assert.deepEqual(made('ses').map((call) => call[2]), ['ana@shop.example.tn']);
  });

  it('counts a receipt SES refused as done, the receipt written, and names those the bucket refused, to come back', async () => {
    const { receipts } = instance({ RECEIPTS_BUCKET: 'shop-receipts', RECEIPTS_FROM: 'orders@shop.example.tn' });
    world.sesFails = true;
    assert.deepEqual(await receipts({ Records: records.slice(0, 1) }), { batchItemFailures: [] });
    world.s3Fails = true;
    assert.deepEqual(await receipts({ Records: records }), { batchItemFailures: [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }] });
  });
});

describe('the night, orders-nightly', () => {
  it('removes the old orders with their receipts, and clears the latest orders in the cache', async () => {
    const { nightly } = instance({ REDIS_URL: 'rediss://default:pw@cache.example.tn:6400', RECEIPTS_BUCKET: 'shop-receipts' });
    world.removed = [3, 4];
    const report = await nightly({ time: '2026-10-31T02:00:00Z' });
    assert.deepEqual([report.removed, report.receipts], [2, 2]);
    assert.deepEqual(made('cache').map((call) => call[1]), ['connect', 'DEL orders:latest']);
  });

  it('leaves the cache alone when it removes nothing', async () => {
    const { nightly } = instance({ REDIS_URL: 'rediss://default:pw@cache.example.tn:6400', RECEIPTS_BUCKET: 'shop-receipts' });
    await nightly({ time: '2026-10-31T02:00:00Z' });
    assert.deepEqual(made('cache'), []);
  });
});

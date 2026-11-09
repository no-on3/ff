/**
 * SQS's operations as FF answers them. The requests and answers that ff local's SQS shares are sqs-examples.json's,
 * which its tests read too; what only FF has, its keys' kinds and reach, the plan, the audit log, the counts SQS bills
 * and the tags, stays here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { plan } from '../plans/test-fixtures';
import { ResourceTagsService, Tagged } from '../tags/resource-tags.service';
import { tagsProblem } from '../tags/tag-rules';
import { CustomerQueues, Outgoing, Received } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueRequestCounts } from './queue-request-counts.service';
import { QueueStore } from './queue-store';
import { Queue, QueueKind } from './queue.entity';
import { DEFAULT_SETTINGS } from './sqs-attributes';
import { SqsError } from './sqs-error';
import { MessageAttribute, messageSize, parseReceiptHandle, receiptHandle } from './sqs-messages';
import { Caller, SqsOperations } from './sqs-operations';

const BASE = 'http://localhost:3003';
const REGION = 'tn-tunis-1';
const ACCOUNT = '000000000001';
const URL_ = `${BASE}/${ACCOUNT}/orders`;

const ORDERS: Queue = Object.assign(new Queue(), {
  id: 'queue-orders',
  accountId: ACCOUNT,
  name: 'orders',
  kind: QueueKind.CUSTOMER,
  functionId: null,
  sizeBytes: '0',
  ...DEFAULT_SETTINGS,
  createdAt: new Date('2026-10-23T08:00:00Z'),
  updatedAt: new Date('2026-10-23T08:00:00Z'),
});

/** A message the queue holds before a request, as the table writes it. */
interface Held {
  id: string;
  messageId: string;
  body: string;
  meta: { senderId?: string; messageAttributes?: Record<string, MessageAttribute> };
  sentAt: string;
  receiveCount: number;
  firstReceivedAt?: string;
  visibleAt?: string;
}

/** A request to an operation and its answer or refusal, as sqs-examples.json writes them. */
interface Example {
  title: string;
  operation: string;
  input: Record<string, unknown>;
  queue?: Partial<Queue>;
  holds?: Held[];
  at?: string;
  answer?: Record<string, unknown>;
  refused?: { status: number; type: string; message: string };
  kept?: unknown[];
  notLookedFor?: boolean;
}

const table = JSON.parse(readFileSync(join(__dirname, 'sqs-examples.json'), 'utf8')) as { operations: Record<string, Example[]> };

/** The table's placeholders filled with this test's endpoint, account, region and key; {x*N}, N x's. */
function filled<T>(value: T): T {
  if (typeof value === 'string') {
    const many = /^\{x\*(\d+)\}$/.exec(value);
    if (many) return 'x'.repeat(Number(many[1])) as T;
    return value
      .replaceAll('{queueUrl}', '{endpoint}/{account}/orders')
      .replaceAll('{endpoint}', BASE)
      .replaceAll('{account}', ACCOUNT)
      .replaceAll('{region}', REGION)
      .replaceAll('{keyId}', 'AKFFAAAAAAAAAAAAAAAA') as T;
  }
  if (Array.isArray(value)) return value.map(filled) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item)])) as T;
  return value;
}

/** An answer with each {messageId} the ID of the message kept, in order. */
function withIds(value: unknown, sent: Outgoing[]): unknown {
  let next = 0;
  const each = (item: unknown): unknown => {
    if (item === '{messageId}') return sent[next++]?.messageId;
    if (Array.isArray(item)) return item.map(each);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, each(inner)]));
    return item;
  };
  return each(value);
}

const received = (n: number, extra: Partial<Received> = {}): Received => ({
  id: String(100 + n),
  messageId: `6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a${String(n).padStart(2, '0')}`,
  body: `message ${n}`,
  meta: { senderId: 'AKFFAAAAAAAAAAAAAAAA' },
  sentAt: new Date('2026-10-23T08:00:00Z'),
  receiveCount: 1,
  firstReceivedAt: new Date('2026-10-23T08:00:05Z'),
  sizeBytes: Buffer.byteLength(`message ${n}`),
  ...extra,
});

/**
 * The messages a table's case holds, as the database would answer for them at its time: a receive takes those that can
 * be received, the oldest first, each hidden for the visibility timeout and its receive counted; the counts and a
 * visibility changed as its SQL has them.
 */
function heldQueue(holds: Held[], at: string) {
  const now = Date.parse(at);
  const messages = holds.map((message) => ({ ...message, visibleAt: Date.parse(message.visibleAt ?? message.sentAt) }));
  const names = (receipt: { id: string; receiveCount: number; messageId: string }) => (message: (typeof messages)[number]) =>
    message.id === receipt.id && message.receiveCount === receipt.receiveCount && message.messageId === receipt.messageId;
  return {
    receive: (max: number, visibility: number): Received[] =>
      messages
        .filter((message) => message.visibleAt <= now)
        .slice(0, max)
        .map((message) => {
          message.receiveCount += 1;
          message.firstReceivedAt ??= at;
          message.visibleAt = now + visibility * 1000;
          return {
            id: message.id,
            messageId: message.messageId,
            body: message.body,
            meta: message.meta,
            sentAt: new Date(message.sentAt),
            receiveCount: message.receiveCount,
            firstReceivedAt: new Date(message.firstReceivedAt),
            sizeBytes: messageSize(message.body, message.meta.messageAttributes ?? {}),
          };
        }),
    counts: () => ({
      visible: messages.filter((message) => message.visibleAt <= now).length,
      notVisible: messages.filter((message) => message.visibleAt > now && message.receiveCount > 0).length,
      delayed: messages.filter((message) => message.visibleAt > now && message.receiveCount === 0).length,
    }),
    changeVisibility: (receipt: { id: string; receiveCount: number; messageId: string }, timeout: number): boolean => {
      const message = messages.find((held) => names(receipt)(held) && held.visibleAt > now);
      if (message) message.visibleAt = now + timeout * 1000;
      return message !== undefined;
    },
  };
}

/**
 * The database's side, as each test sets it: the queues are found by name; what is sent is kept in `sent`. A table's
 * case gives what its queue holds and when it is asked, `holds` and `at`, and its settings, `queue`; another test, what
 * each receive answers, `receives`.
 */
function setup(options: { bytes?: number; receives?: Received[][]; holds?: Held[]; at?: string; queue?: Partial<Queue> } = {}) {
  const sent: Outgoing[] = [];
  const receives = [...(options.receives ?? [])];
  const held = heldQueue(options.holds ?? [], options.at ?? new Date().toISOString());
  const orders: Queue = Object.assign(new Queue(), { ...ORDERS, ...options.queue });
  const queues = {
    find: jest.fn(async (accountId: string, name: string) => (accountId === ACCOUNT && name === 'orders' ? orders : null)),
    create: jest.fn(async (accountId: string, name: string, settings: object, _plan: object, _region: string, alongside?: (manager: EntityManager, queue: Queue) => Promise<void>) => {
      const queue = Object.assign(new Queue(), { ...ORDERS, id: `queue-${name}`, accountId, name, ...settings });
      await alongside?.({} as EntityManager, queue);
      return { queue, created: true };
    }),
    setAttributes: jest.fn(async () => undefined),
    list: jest.fn(async () => ({ queues: [ORDERS] })),
    delete: jest.fn(async () => undefined),
    purge: jest.fn(async () => undefined),
    counts: jest.fn(async () => held.counts()),
    send: jest.fn(async (_queue: Queue, messages: Outgoing[]) => void sent.push(...messages)),
    receive: jest.fn(async (_queue: Queue, max: number, visibility: number) => (options.receives ? (receives.shift() ?? []) : held.receive(max, visibility))),
    deleteMessages: jest.fn(async () => undefined),
    changeVisibility: jest.fn(async (_queue: Queue, receipt: { id: string; receiveCount: number; messageId: string }, timeout: number) => held.changeVisibility(receipt, timeout)),
  };
  const store = { accountBytes: jest.fn(async () => options.bytes ?? 0) };
  const events = { wait: jest.fn(async (): Promise<void> => undefined) };
  const audit = { record: jest.fn(async (_event: object): Promise<void> => undefined) };
  const counts = { count: jest.fn() };
  // Each queue's tags by its ID, checked by AWS's rules as FF's tags' service checks them.
  const tagged = new Map<string, Record<string, string>>();
  const checked = (existing: Record<string, string>, adding: Record<string, string>) => {
    const problem = tagsProblem(existing, adding);
    if (problem) throw new BadRequestException(problem);
  };
  const tags = {
    of: jest.fn(async ({ id }: Tagged) => ({ ...tagged.get(id) })),
    tag: jest.fn(async (_account: string, { id }: Tagged, adding: Record<string, string>, _by?: object) => {
      checked(tagged.get(id) ?? {}, adding);
      tagged.set(id, { ...tagged.get(id), ...adding });
    }),
    untag: jest.fn(async (_account: string, { id }: Tagged, keys: string[], _by?: object) => {
      tagged.set(id, Object.fromEntries(Object.entries(tagged.get(id) ?? {}).filter(([key]) => !keys.includes(key))));
    }),
    putNew: jest.fn(async (_manager: EntityManager, _account: string, { id }: Tagged, adding: Record<string, string>) => {
      checked({}, adding);
      tagged.set(id, adding);
    }),
  };
  const operations = new SqsOperations(
    queues as unknown as CustomerQueues,
    store as unknown as QueueStore,
    events as unknown as QueueEvents,
    audit as unknown as AuditService,
    counts as unknown as QueueRequestCounts,
    tags as unknown as ResourceTagsService,
    BASE,
    REGION,
  );
  return { operations, queues, store, events, sent, audit, counts, tags };
}

const caller = (extra: Partial<Caller> = {}): Caller => ({ accountId: ACCOUNT, keyId: 'AKFFAAAAAAAAAAAAAAAA', readOnly: false, plan: plan(), ...extra });

async function refusal(promise: Promise<unknown>): Promise<{ type: string; message: string; status: number }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SqsError) return { type: error.type, message: error.message, status: error.status };
    throw error;
  }
  throw new Error('not refused');
}

/**
 * Each case of the table's group, on a queue that holds what the case says: its answer, or its refusal, and what a send
 * kept, none when refused, each named by its title. Answers each case's stand-ins, for what only FF checks.
 */
async function answersAsTheTableSays(group: string): Promise<Array<ReturnType<typeof setup>>> {
  const ran: Array<ReturnType<typeof setup>> = [];
  for (const example of table.operations[group]) {
    const stage = setup({ holds: example.holds, at: example.at, queue: example.queue });
    ran.push(stage);
    const call = stage.operations.run(example.operation, filled(example.input), caller());
    if (example.refused) {
      expect([example.title, await refusal(call)]).toEqual([example.title, filled(example.refused)]);
      if (example.notLookedFor) expect([example.title, stage.queues.find.mock.calls]).toEqual([example.title, []]);
    } else {
      expect([example.title, await call]).toEqual([example.title, withIds(filled(example.answer), stage.sent)]);
    }
    expect([example.title, stage.sent.map(({ messageId, ...kept }) => ({ messageId: /^[0-9a-f-]{36}$/.test(messageId), ...kept }))]).toEqual([
      example.title,
      filled(example.kept ?? []).map((kept) => ({ messageId: true, ...(kept as object) })),
    ]);
  }
  return ran;
}

describe("SQS's operations on an account's queues", () => {
  describe('which operations, for which key', () => {
    it("answers UnsupportedOperation for SQS's operations FF doesn't offer, and for names SQS doesn't have", async () => {
      await answersAsTheTableSays('unsupported');
    });

    it('lets a read-only key read the queues and receive, but not send, delete or change them', async () => {
      const { operations } = setup();
      const reader = caller({ readOnly: true });
      await expect(operations.run('GetQueueUrl', { QueueName: 'orders' }, reader)).resolves.toEqual({ QueueUrl: URL_ });
      await expect(operations.run('ReceiveMessage', { QueueUrl: URL_ }, reader)).resolves.toEqual({});
      await expect(operations.run('ListQueueTags', { QueueUrl: URL_ }, reader)).resolves.toEqual({});
      for (const operation of ['SendMessage', 'DeleteMessage', 'CreateQueue', 'DeleteQueue', 'PurgeQueue', 'SetQueueAttributes', 'ChangeMessageVisibility', 'TagQueue', 'UntagQueue']) {
        expect(await refusal(operations.run(operation, { QueueUrl: URL_ }, reader))).toMatchObject({ type: 'AccessDenied', status: 403 });
      }
    });
  });

  describe("a queue's URL", () => {
    it('is <endpoint>/<account>/<name>, and any host reaches it by its path', async () => {
      for (const { queues } of await answersAsTheTableSays('anyHost')) expect(queues.find.mock.calls).toEqual([[ACCOUNT, 'orders']]);
    });

    it("names another account's queue as one that doesn't exist, without looking for it", async () => {
      await answersAsTheTableSays('notThere');
    });

    it("answers GetQueueUrl for the account's own queues only", async () => {
      await answersAsTheTableSays('queueUrl');
    });
  });

  describe('CreateQueue', () => {
    it("makes a queue with the attributes given, within the plan's queues, and answers its URL", async () => {
      const { operations, queues } = setup();
      await expect(operations.run('CreateQueue', { QueueName: 'invoices', Attributes: { VisibilityTimeout: '60' } }, caller())).resolves.toEqual({
        QueueUrl: `${BASE}/${ACCOUNT}/invoices`,
      });
      expect(queues.create).toHaveBeenCalledWith(ACCOUNT, 'invoices', { visibilityTimeout: 60 }, { limit: plan().limits.queues, name: plan().name }, REGION, undefined);
    });

    it('makes a queue with its tags, kept in the transaction that makes it, which its entry in the audit log names', async () => {
      const { operations, tags, audit } = setup();
      await operations.run('CreateQueue', { QueueName: 'invoices', tags: { team: 'billing', stage: 'dev' } }, caller());

      expect(tags.putNew).toHaveBeenCalledWith({}, ACCOUNT, { kind: 'queue', id: 'queue-invoices', resource: 'queue:invoices' }, { team: 'billing', stage: 'dev' });
      expect(audit.record).toHaveBeenCalledWith({ accountId: ACCOUNT, action: 'queue.create', resource: 'queue:invoices', details: { attributes: {}, tags: { team: 'billing', stage: 'dev' } } });
    });

    it('refuses tags SQS would refuse, and FIFO queues', async () => {
      const { operations } = setup();
      expect(await refusal(operations.run('CreateQueue', { QueueName: 'invoices', tags: { 'aws:team': 'billing' } }, caller()))).toMatchObject({
        type: 'InvalidParameterValue',
        message: 'The key aws:team starts with aws:, which AWS keeps for its own tags.',
      });
      expect((await refusal(operations.run('CreateQueue', { QueueName: 'invoices', tags: ['team'] }, caller()))).message).toBe(
        "Value for parameter tags is invalid. Reason: It must map each tag's key to its value, a string.",
      );
      expect((await refusal(operations.run('CreateQueue', { QueueName: 'invoices.fifo' }, caller()))).type).toBe('InvalidParameterValue');
    });
  });

  describe("a queue's tags, as SQS's", () => {
    const by = { actor: { id: 'access_key:AKFFAAAAAAAAAAAAAAAA', label: 'access key AKFFAAAAAAAAAAAAAAAA' }, ip: '10.0.0.7' };

    it('puts tags, a key there taking its new value, removes them by key, and lists them, none when there are none; each change under its caller', async () => {
      const { operations, tags } = setup();
      expect(await operations.run('ListQueueTags', { QueueUrl: URL_ }, caller())).toEqual({});

      await operations.run('TagQueue', { QueueUrl: URL_, Tags: { team: 'shop', stage: 'dev' } }, caller(by));
      await operations.run('TagQueue', { QueueUrl: URL_, Tags: { stage: 'prod' } }, caller(by));
      expect(await operations.run('ListQueueTags', { QueueUrl: URL_ }, caller())).toEqual({ Tags: { team: 'shop', stage: 'prod' } });
      await operations.run('UntagQueue', { QueueUrl: URL_, TagKeys: ['team', 'never-there'] }, caller(by));

      expect(await operations.run('ListQueueTags', { QueueUrl: URL_ }, caller())).toEqual({ Tags: { stage: 'prod' } });
      const orders = { kind: 'queue', id: 'queue-orders', resource: 'queue:orders' };
      expect(tags.tag).toHaveBeenCalledWith(ACCOUNT, orders, { stage: 'prod' }, by);
      expect(tags.untag).toHaveBeenCalledWith(ACCOUNT, orders, ['team', 'never-there'], by);
    });

    it("refuses what SQS refuses: a tag AWS wouldn't take or past 50, InvalidParameterValue; none given, MissingParameter; another queue's, QueueDoesNotExist", async () => {
      const { operations } = setup();
      const refused = async (operation: string, input: Record<string, unknown>) => {
        const { type, message } = await refusal(operations.run(operation, { QueueUrl: URL_, ...input }, caller()));
        return `${type}: ${message}`;
      };

      expect(await refused('TagQueue', { Tags: { 'a<b': 'x' } })).toBe("InvalidParameterValue: The key a<b holds a character a tag can't: letters, digits, spaces and + - = . _ : / @ only.");
      expect(await refused('TagQueue', { Tags: Object.fromEntries(Array.from({ length: 51 }, (_, n) => [`k${n}`, 'v'])) })).toBe(
        'InvalidParameterValue: A resource has at most 50 tags: these would make it 51.',
      );
      expect(await refused('TagQueue', { Tags: { team: 7 } })).toBe("InvalidParameterValue: Value for parameter Tags is invalid. Reason: It must map each tag's key to its value, a string.");
      expect(await refused('TagQueue', {})).toBe('MissingParameter: The request must contain the parameter Tags.');
      expect(await refused('UntagQueue', { TagKeys: [] })).toBe('MissingParameter: The request must contain the parameter TagKeys.');
      expect(await refused('UntagQueue', { TagKeys: [7] })).toBe('InvalidParameterValue: Value for parameter TagKeys is invalid. Reason: Each tag key must be a string.');
      expect(await refused('ListQueueTags', { QueueUrl: `${BASE}/000000000002/orders` })).toBe('QueueDoesNotExist: The specified queue does not exist.');
    });
  });

  describe('SendMessage', () => {
    it('keeps the message, and answers its ID and the MD5 sums of its body and attributes', async () => {
      await answersAsTheTableSays('sendKept');
    });

    it("takes the queue's delay when the message names none, and refuses one past 15 minutes", async () => {
      await answersAsTheTableSays('sendDelay');
    });

    it("refuses a message larger than the queue's maximum, and FIFO queues' parameters", async () => {
      await answersAsTheTableSays('sendRefused');
    });

    it("refuses a message once the account's messages hold the plan's storage, its asynchronous calls among them", async () => {
      const limit = plan().limits.queueStorageMb * 1024 * 1024;
      const { operations, sent } = setup({ bytes: limit - 3 });
      await operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'abc' }, caller());
      expect(await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'abcd' }, caller()))).toMatchObject({ type: 'OverLimit', status: 400 });
      expect(sent).toHaveLength(1);
    });
  });

  describe('SendMessageBatch', () => {
    it('keeps every entry in one write, and answers each by its ID', async () => {
      const [{ queues }] = await answersAsTheTableSays('batchKept');
      expect(queues.send).toHaveBeenCalledTimes(1);
    });

    it("answers an entry SQS would refuse as failed, and keeps the others", async () => {
      await answersAsTheTableSays('batchFailedEntry');
    });

    it("refuses a batch as SQS does: empty, more than ten, an ID twice or not SQS's, over 1 MiB together", async () => {
      await answersAsTheTableSays('batchRefused');
    });
  });

  describe('ReceiveMessage', () => {
    it('answers the messages there are, with their receipt handles and MD5 sums, and no attributes not asked for', async () => {
      const [{ queues, events }] = await answersAsTheTableSays('received');
      expect(queues.receive).toHaveBeenCalledWith(ORDERS, 10, 45, expect.any(Date));
      expect(events.wait).not.toHaveBeenCalled();
    });

    it("answers the system attributes asked for, All or by name, as SQS's newer and older parameters name them", async () => {
      await answersAsTheTableSays('systemAttributes');
    });

    it('answers the message attributes asked for, All, by name or by prefix, and the MD5 sum of those it answers', async () => {
      await answersAsTheTableSays('messageAttributes');
    });

    it("waits for the queue's news when none are there and the receive waits, then receives again", async () => {
      const { operations, queues, events } = setup({ receives: [[], [received(1)]] });
      const answer = await operations.run('ReceiveMessage', { QueueUrl: URL_, WaitTimeSeconds: 20 }, caller());
      expect((answer.Messages as unknown[]).length).toBe(1);
      expect(events.wait).toHaveBeenCalledTimes(1);
      expect(events.wait).toHaveBeenCalledWith(ORDERS.id, expect.any(Number), undefined);
      expect(queues.receive).toHaveBeenCalledTimes(2);
    });

    it('answers no messages at once without a wait, and ends its wait when the client goes', async () => {
      const once = setup();
      await expect(once.operations.run('ReceiveMessage', { QueueUrl: URL_ }, caller())).resolves.toEqual({});
      expect(once.events.wait).not.toHaveBeenCalled();
      const gone = new AbortController();
      const waiting = setup();
      waiting.events.wait.mockImplementation(async () => {
        gone.abort();
      });
      await expect(waiting.operations.run('ReceiveMessage', { QueueUrl: URL_, WaitTimeSeconds: 20 }, caller({ signal: gone.signal }))).resolves.toEqual({});
      expect(waiting.events.wait).toHaveBeenCalledTimes(1);
    });

    it("refuses SQS's out-of-range parameters", async () => {
      await answersAsTheTableSays('receiveRefused');
    });
  });

  describe('DeleteMessage and ChangeMessageVisibility', () => {
    const handle = receiptHandle({ id: '101', receiveCount: 1, messageId: '6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a01' });

    it("deletes the message its receipt handle names, and refuses a handle no receive gave", async () => {
      const [{ queues }] = await answersAsTheTableSays('deleted');
      expect(queues.deleteMessages).toHaveBeenCalledWith(ORDERS, [parseReceiptHandle(handle)]);
    });

    it('answers each entry of a batch, a failed one beside the others', async () => {
      const [{ queues }] = await answersAsTheTableSays('deleteBatch');
      expect(queues.deleteMessages).toHaveBeenCalledWith(ORDERS, [parseReceiptHandle(handle)]);
    });

    it('changes a received message\'s visibility, and answers MessageNotInflight for one not received any more', async () => {
      const [{ queues }] = await answersAsTheTableSays('visibility');
      expect(queues.changeVisibility).toHaveBeenCalledWith(ORDERS, parseReceiptHandle(handle), 120, expect.any(Date));
    });
  });

  describe("a key's reach", () => {
    const naming = (queues: string[] | null, buckets: string[] | null = null, functions: string[] | null = null) => caller({ reach: { buckets, queues, functions } });

    it('lets a key that names queues reach those alone, refusing another before it is looked for, as IAM refuses one', async () => {
      const { operations, queues } = setup();
      const key = naming(['invoices']);
      expect(await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x' }, key))).toMatchObject({
        type: 'AccessDenied',
        status: 403,
        message: `Access to the resource ${URL_} is denied: the access key names the queues it reaches, and not this one.`,
      });
      expect(queues.find).not.toHaveBeenCalled();
      expect((await refusal(operations.run('GetQueueUrl', { QueueName: 'orders' }, key))).type).toBe('AccessDenied');
      expect((await refusal(operations.run('CreateQueue', { QueueName: 'orders' }, key))).type).toBe('AccessDenied');
      await expect(operations.run('ListQueues', {}, key)).resolves.toEqual({});
      await expect(operations.run('GetQueueUrl', { QueueName: 'orders' }, naming(['orders']))).resolves.toEqual({ QueueUrl: URL_ });
    });

    it('lets a key that names buckets or functions alone reach no queue, and one that names nothing every one', async () => {
      const { operations } = setup();
      expect((await refusal(operations.run('GetQueueUrl', { QueueName: 'orders' }, naming(null, ['photos'])))).type).toBe('AccessDenied');
      expect((await refusal(operations.run('GetQueueUrl', { QueueName: 'orders' }, naming(null, null, ['thumbnails'])))).type).toBe('AccessDenied');
      await expect(operations.run('GetQueueUrl', { QueueName: 'orders' }, naming(null))).resolves.toEqual({ QueueUrl: URL_ });
    });

    it("tells the caller what its key used, by SQS's names: a queue it reached, the account's for ListQueues; nothing refused, nor a queue that isn't there", async () => {
      const { operations } = setup();
      const used: string[] = [];
      const noting = (extra: Partial<Caller> = {}) => caller({ used: (operation, queue) => void used.push(`${operation} ${queue || '(the account)'}`), ...extra });

      await operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x' }, noting());
      await operations.run('ReceiveMessage', { QueueUrl: URL_ }, noting({ readOnly: true }));
      await operations.run('ListQueues', {}, noting());
      await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x' }, noting({ readOnly: true })));
      await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x' }, noting({ reach: { buckets: null, queues: ['invoices'], functions: null } })));
      await refusal(operations.run('GetQueueUrl', { QueueName: 'gone' }, noting()));

      expect(used).toEqual(['SendMessage orders', 'ReceiveMessage orders', 'ListQueues (the account)']);
    });
  });

  it('writes each change of a queue in the audit log, as the caller given: made, changed, purged and deleted, but not made again', async () => {
    const { operations, queues, audit } = setup();
    const key = caller({ actor: { id: 'access_key:AKFFAAAAAAAAAAAAAAAA', label: 'access key AKFFAAAAAAAAAAAAAAAA' }, ip: '203.0.113.7' });

    await operations.run('CreateQueue', { QueueName: 'invoices', Attributes: { DelaySeconds: '5' } }, key);
    queues.create.mockResolvedValueOnce({ queue: ORDERS, created: false });
    await operations.run('CreateQueue', { QueueName: 'orders' }, key);
    await operations.run('SetQueueAttributes', { QueueUrl: URL_, Attributes: { VisibilityTimeout: '60' } }, key);
    await operations.run('PurgeQueue', { QueueUrl: URL_ }, key);
    await operations.run('DeleteQueue', { QueueUrl: URL_ }, caller());

    const who = { actor: key.actor, ip: '203.0.113.7' };
    expect(audit.record.mock.calls.map(([event]) => event)).toEqual([
      { accountId: ACCOUNT, action: 'queue.create', resource: 'queue:invoices', details: { attributes: { delaySeconds: 5 } }, ...who },
      { accountId: ACCOUNT, action: 'queue.update', resource: 'queue:orders', details: { attributes: { visibilityTimeout: 60 } }, ...who },
      { accountId: ACCOUNT, action: 'queue.purge', resource: 'queue:orders', ...who },
      // FF's API names no caller: the audit log takes its request's.
      { accountId: ACCOUNT, action: 'queue.delete', resource: 'queue:orders' },
    ]);
  });

  describe('what each request counts, as SQS bills it and CloudWatch counts its messages', () => {
    const counted = (extra: object = {}) => ({ queueId: 'queue-orders', accountId: ACCOUNT, queueName: 'orders', requests: 1, sentSizes: [], received: 0, deleted: 0, emptyReceives: 0, ...extra });

    it('bills a send each 64 KB of its messages, and counts the messages kept with their sizes, a failed entry none', async () => {
      const { operations, counts } = setup();
      await operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x'.repeat(70_000) }, caller());
      await operations.run('SendMessageBatch', { QueueUrl: URL_, Entries: [{ Id: 'a', MessageBody: 'one' }, { Id: 'b', MessageBody: '' }, { Id: 'c', MessageBody: 'three' }] }, caller());

      expect(counts.count.mock.calls).toEqual([[counted({ requests: 2, sentSizes: [70_000] })], [counted({ sentSizes: [3, 5] })]]);
    });

    it("bills a receive each 64 KB of the messages it answers, counts them, and counts one that answers none as an empty receive", async () => {
      const big = received(1, { body: 'y'.repeat(100_000), sizeBytes: 100_000 });
      const { operations, counts } = setup({ receives: [[big, received(2)], []] });
      await operations.run('ReceiveMessage', { QueueUrl: URL_, MaxNumberOfMessages: 10 }, caller());
      await operations.run('ReceiveMessage', { QueueUrl: URL_ }, caller());

      expect(counts.count.mock.calls).toEqual([[counted({ requests: 2, received: 2 })], [counted({ emptyReceives: 1 })]]);
    });

    it('counts each valid receipt handle a delete takes as a message deleted, one refused none', async () => {
      const { operations, counts } = setup();
      const handle = receiptHandle({ id: '101', receiveCount: 1, messageId: received(1).messageId });
      await operations.run('DeleteMessage', { QueueUrl: URL_, ReceiptHandle: handle }, caller());
      await operations.run('DeleteMessageBatch', { QueueUrl: URL_, Entries: [{ Id: 'a', ReceiptHandle: handle }, { Id: 'b', ReceiptHandle: 'not one' }] }, caller());

      expect(counts.count.mock.calls).toEqual([[counted({ deleted: 1 })], [counted({ deleted: 1 })]]);
    });

    it('bills a request refused once its queue is found, and counts nothing of one that names no queue there, of ListQueues, or of a read-only key refused', async () => {
      const { operations, counts } = setup();
      await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: '' }, caller()));
      await operations.run('CreateQueue', { QueueName: 'invoices' }, caller());
      await refusal(operations.run('GetQueueAttributes', { QueueUrl: `${BASE}/${ACCOUNT}/nope` }, caller()));
      await operations.run('ListQueues', {}, caller());
      await refusal(operations.run('PurgeQueue', { QueueUrl: URL_ }, caller({ readOnly: true })));

      expect(counts.count.mock.calls).toEqual([[counted()], [counted({ queueId: 'queue-invoices', queueName: 'invoices' })]]);
    });
  });

  it("answers ListQueues' URLs, and GetQueueAttributes' counts", async () => {
    const { operations, queues } = setup();
    await expect(operations.run('ListQueues', { QueueNamePrefix: 'ord', MaxResults: 5 }, caller())).resolves.toEqual({ QueueUrls: [URL_] });
    expect(queues.list).toHaveBeenCalledWith(ACCOUNT, 'ord', 5, undefined);
    await answersAsTheTableSays('counts');
  });
});

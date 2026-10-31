import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { plan } from '../plans/test-fixtures';
import { CustomerQueues, Outgoing, Received } from './customer-queues';
import { QueueEvents } from './queue-events';
import { QueueRequestCounts } from './queue-request-counts.service';
import { QueueStore } from './queue-store';
import { Queue, QueueKind } from './queue.entity';
import { DEFAULT_SETTINGS } from './sqs-attributes';
import { SqsError } from './sqs-error';
import { attributesMd5, parseReceiptHandle, receiptHandle } from './sqs-messages';
import { Caller, SqsOperations } from './sqs-operations';

const BASE = 'http://localhost:3003';
const REGION = 'tn-tunis-1';
const ACCOUNT = '000000000001';
const URL_ = `${BASE}/${ACCOUNT}/orders`;
const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

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

/** The database's side, as each test sets it: the queues are found by name; what is sent is kept in `sent`. */
function setup(options: { bytes?: number; receives?: Received[][] } = {}) {
  const sent: Outgoing[] = [];
  const receives = [...(options.receives ?? [])];
  const queues = {
    find: jest.fn(async (accountId: string, name: string) => (accountId === ACCOUNT && name === 'orders' ? ORDERS : null)),
    create: jest.fn(async (accountId: string, name: string, settings: object) => ({ queue: Object.assign(new Queue(), { ...ORDERS, accountId, name, ...settings }), created: true })),
    setAttributes: jest.fn(async () => undefined),
    list: jest.fn(async () => ({ queues: [ORDERS] })),
    delete: jest.fn(async () => undefined),
    purge: jest.fn(async () => undefined),
    counts: jest.fn(async () => ({ visible: 3, notVisible: 2, delayed: 1 })),
    send: jest.fn(async (_queue: Queue, messages: Outgoing[]) => void sent.push(...messages)),
    receive: jest.fn(async () => receives.shift() ?? []),
    deleteMessages: jest.fn(async () => undefined),
    changeVisibility: jest.fn(async () => true),
  };
  const store = { accountBytes: jest.fn(async () => options.bytes ?? 0) };
  const events = { wait: jest.fn(async (): Promise<void> => undefined) };
  const audit = { record: jest.fn(async (_event: object): Promise<void> => undefined) };
  const counts = { count: jest.fn() };
  const operations = new SqsOperations(
    queues as unknown as CustomerQueues,
    store as unknown as QueueStore,
    events as unknown as QueueEvents,
    audit as unknown as AuditService,
    counts as unknown as QueueRequestCounts,
    BASE,
    REGION,
  );
  return { operations, queues, store, events, sent, audit, counts };
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

describe("SQS's operations on an account's queues", () => {
  describe('which operations, for which key', () => {
    it("answers UnsupportedOperation for SQS's operations FF doesn't offer, and for names SQS doesn't have", async () => {
      const { operations } = setup();
      expect(await refusal(operations.run('TagQueue', { QueueUrl: URL_ }, caller()))).toMatchObject({ type: 'UnsupportedOperation', message: "FF's queues don't offer TagQueue." });
      expect((await refusal(operations.run('MakeCoffee', {}, caller()))).type).toBe('UnsupportedOperation');
    });

    it('lets a read-only key read the queues and receive, but not send, delete or change them', async () => {
      const { operations } = setup();
      const reader = caller({ readOnly: true });
      await expect(operations.run('GetQueueUrl', { QueueName: 'orders' }, reader)).resolves.toEqual({ QueueUrl: URL_ });
      await expect(operations.run('ReceiveMessage', { QueueUrl: URL_ }, reader)).resolves.toEqual({});
      for (const operation of ['SendMessage', 'DeleteMessage', 'CreateQueue', 'DeleteQueue', 'PurgeQueue', 'SetQueueAttributes', 'ChangeMessageVisibility']) {
        expect(await refusal(operations.run(operation, { QueueUrl: URL_ }, reader))).toMatchObject({ type: 'AccessDenied', status: 403 });
      }
    });
  });

  describe("a queue's URL", () => {
    it('is <endpoint>/<account>/<name>, and any host reaches it by its path', async () => {
      const { operations, queues } = setup();
      for (const url of [URL_, `https://sqs.tn-tunis-1.amazonaws.com/${ACCOUNT}/orders`, `${URL_}/`, `/${ACCOUNT}/orders`]) {
        await expect(operations.run('GetQueueAttributes', { QueueUrl: url, AttributeNames: ['QueueArn'] }, caller())).resolves.toEqual({
          Attributes: { QueueArn: 'arn:aws:sqs:tn-tunis-1:000000000001:orders' },
        });
      }
      expect(queues.find).toHaveBeenCalledWith(ACCOUNT, 'orders');
    });

    it("names another account's queue as one that doesn't exist, without looking for it", async () => {
      const { operations, queues } = setup();
      expect(await refusal(operations.run('SendMessage', { QueueUrl: `${BASE}/000000000002/orders`, MessageBody: 'x' }, caller()))).toMatchObject({
        type: 'QueueDoesNotExist',
        message: 'The specified queue does not exist.',
      });
      expect(queues.find).not.toHaveBeenCalled();
      expect((await refusal(operations.run('SendMessage', { QueueUrl: `${BASE}/${ACCOUNT}/gone`, MessageBody: 'x' }, caller()))).type).toBe('QueueDoesNotExist');
      expect((await refusal(operations.run('SendMessage', { MessageBody: 'x' }, caller()))).type).toBe('MissingParameter');
    });

    it("answers GetQueueUrl for the account's own queues only", async () => {
      const { operations } = setup();
      expect((await refusal(operations.run('GetQueueUrl', { QueueName: 'orders', QueueOwnerAWSAccountId: '000000000002' }, caller()))).type).toBe('QueueDoesNotExist');
      await expect(operations.run('GetQueueUrl', { QueueName: 'orders', QueueOwnerAWSAccountId: ACCOUNT }, caller())).resolves.toEqual({ QueueUrl: URL_ });
    });
  });

  describe('CreateQueue', () => {
    it("makes a queue with the attributes given, within the plan's queues, and answers its URL", async () => {
      const { operations, queues } = setup();
      await expect(operations.run('CreateQueue', { QueueName: 'invoices', Attributes: { VisibilityTimeout: '60' } }, caller())).resolves.toEqual({
        QueueUrl: `${BASE}/${ACCOUNT}/invoices`,
      });
      expect(queues.create).toHaveBeenCalledWith(ACCOUNT, 'invoices', { visibilityTimeout: 60 }, { limit: plan().limits.queues, name: plan().name }, REGION);
    });

    it("refuses tags, which FF's queues don't have yet, and FIFO queues", async () => {
      const { operations } = setup();
      expect((await refusal(operations.run('CreateQueue', { QueueName: 'invoices', tags: { team: 'billing' } }, caller()))).message).toBe("FF's queues have no tags yet.");
      expect((await refusal(operations.run('CreateQueue', { QueueName: 'invoices.fifo' }, caller()))).type).toBe('InvalidParameterValue');
    });
  });

  describe('SendMessage', () => {
    const attributes = { color: { DataType: 'String', StringValue: 'red' } };

    it('keeps the message, and answers its ID and the MD5 sums of its body and attributes', async () => {
      const { operations, sent } = setup();
      const answer = await operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'سلام', MessageAttributes: attributes, DelaySeconds: 5 }, caller());
      expect(answer).toEqual({ MessageId: sent[0].messageId, MD5OfMessageBody: md5('سلام'), MD5OfMessageAttributes: attributesMd5(attributes) });
      expect(sent).toEqual([
        { messageId: expect.stringMatching(/^[0-9a-f-]{36}$/), body: 'سلام', meta: { senderId: 'AKFFAAAAAAAAAAAAAAAA', messageAttributes: attributes }, sizeBytes: 8 + 5 + 6 + 3, delaySeconds: 5 },
      ]);
    });

    it("takes the queue's delay when the message names none, and refuses one past 15 minutes", async () => {
      const { operations, sent } = setup();
      await operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'later' }, caller());
      expect(sent[0].delaySeconds).toBe(ORDERS.delaySeconds);
      expect(await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'later', DelaySeconds: 901 }, caller()))).toMatchObject({
        type: 'InvalidParameterValue',
        message: 'Value 901 for parameter DelaySeconds is invalid. Reason: Must be between 0 and 900.',
      });
    });

    it("refuses a message larger than the queue's maximum, and FIFO queues' parameters", async () => {
      const { operations } = setup();
      expect((await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x'.repeat(1_048_577) }, caller()))).message).toBe(
        'One or more parameters are invalid. Reason: Message must be shorter than 1048576 bytes.',
      );
      expect((await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x', MessageGroupId: 'g' }, caller()))).message).toContain('standard queues');
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
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ Id: `m${i}`, MessageBody: `batch ${i}` }));

    it('keeps every entry in one write, and answers each by its ID', async () => {
      const { operations, queues, sent } = setup();
      const answer = await operations.run('SendMessageBatch', { QueueUrl: URL_, Entries: entries(10) }, caller());
      expect(queues.send).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(10);
      expect(answer).toEqual({ Successful: sent.map((message, i) => ({ Id: `m${i}`, MessageId: message.messageId, MD5OfMessageBody: md5(`batch ${i}`) })), Failed: [] });
    });

    it("answers an entry SQS would refuse as failed, and keeps the others", async () => {
      const { operations, sent } = setup();
      const answer = await operations.run('SendMessageBatch', { QueueUrl: URL_, Entries: [{ Id: 'good', MessageBody: 'fine' }, { Id: 'bad', MessageBody: '' }] }, caller());
      expect(sent.map((message) => message.body)).toEqual(['fine']);
      expect(answer.Failed).toEqual([{ Id: 'bad', Code: 'InvalidParameterValue', SenderFault: true, Message: 'The request must contain a non-empty message body.' }]);
    });

    it("refuses a batch as SQS does: empty, more than ten, an ID twice or not SQS's, over 1 MiB together", async () => {
      const { operations } = setup();
      const type = async (Entries: unknown) => (await refusal(operations.run('SendMessageBatch', { QueueUrl: URL_, Entries }, caller()))).type;
      expect(await type([])).toBe('EmptyBatchRequest');
      expect(await type(entries(11))).toBe('TooManyEntriesInBatchRequest');
      expect(await type([{ Id: 'same', MessageBody: 'a' }, { Id: 'same', MessageBody: 'b' }])).toBe('BatchEntryIdsNotDistinct');
      expect(await type([{ Id: 'not ok', MessageBody: 'a' }])).toBe('InvalidBatchEntryId');
      expect(await type([{ Id: 'a', MessageBody: 'x'.repeat(600_000) }, { Id: 'b', MessageBody: 'x'.repeat(600_000) }])).toBe('BatchRequestTooLong');
    });
  });

  describe('ReceiveMessage', () => {
    it('answers the messages there are, with their receipt handles and MD5 sums, and no attributes not asked for', async () => {
      const message = received(1, { meta: { senderId: 'AKFFAAAAAAAAAAAAAAAA', messageAttributes: { color: { DataType: 'String', StringValue: 'red' } } } });
      const { operations, queues, events } = setup({ receives: [[message]] });
      const answer = await operations.run('ReceiveMessage', { QueueUrl: URL_, MaxNumberOfMessages: 10, VisibilityTimeout: 45 }, caller());
      expect(answer).toEqual({
        Messages: [{ MessageId: message.messageId, ReceiptHandle: receiptHandle({ id: '101', receiveCount: 1, messageId: message.messageId }), MD5OfBody: md5('message 1'), Body: 'message 1' }],
      });
      expect(queues.receive).toHaveBeenCalledWith(ORDERS, 10, 45, expect.any(Date));
      expect(events.wait).not.toHaveBeenCalled();
    });

    it("answers the system attributes asked for, All or by name, as SQS's newer and older parameters name them", async () => {
      const message = received(1, { receiveCount: 2 });
      const all = await setup({ receives: [[message]] }).operations.run('ReceiveMessage', { QueueUrl: URL_, MessageSystemAttributeNames: ['All'] }, caller());
      expect((all.Messages as Array<{ Attributes: object }>)[0].Attributes).toEqual({
        SenderId: 'AKFFAAAAAAAAAAAAAAAA',
        SentTimestamp: String(Date.parse('2026-10-23T08:00:00Z')),
        ApproximateReceiveCount: '2',
        ApproximateFirstReceiveTimestamp: String(Date.parse('2026-10-23T08:00:05Z')),
      });
      const named = await setup({ receives: [[message]] }).operations.run('ReceiveMessage', { QueueUrl: URL_, AttributeNames: ['ApproximateReceiveCount'] }, caller());
      expect((named.Messages as Array<{ Attributes: object }>)[0].Attributes).toEqual({ ApproximateReceiveCount: '2' });
    });

    it('answers the message attributes asked for, All, by name or by prefix, and the MD5 sum of those it answers', async () => {
      const messageAttributes = {
        'color.main': { DataType: 'String', StringValue: 'red' },
        'color.edge': { DataType: 'String', StringValue: 'blue' },
        size: { DataType: 'Number', StringValue: '3' },
      };
      const message = received(1, { meta: { messageAttributes } });
      const receive = async (MessageAttributeNames: string[]) =>
        ((await setup({ receives: [[message]] }).operations.run('ReceiveMessage', { QueueUrl: URL_, MessageAttributeNames }, caller())).Messages as Array<Record<string, unknown>>)[0];
      expect((await receive(['All'])).MessageAttributes).toEqual(messageAttributes);
      const prefixed = await receive(['color.*']);
      expect(prefixed.MessageAttributes).toEqual({ 'color.main': messageAttributes['color.main'], 'color.edge': messageAttributes['color.edge'] });
      expect(prefixed.MD5OfMessageAttributes).toBe(attributesMd5({ 'color.main': messageAttributes['color.main'], 'color.edge': messageAttributes['color.edge'] }));
      expect((await receive(['size'])).MessageAttributes).toEqual({ size: messageAttributes.size });
      expect(await receive(['weight'])).not.toHaveProperty('MessageAttributes');
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
      const { operations } = setup();
      for (const input of [{ MaxNumberOfMessages: 11 }, { MaxNumberOfMessages: 0 }, { WaitTimeSeconds: 21 }, { VisibilityTimeout: 43_201 }, { VisibilityTimeout: '30' }]) {
        expect((await refusal(operations.run('ReceiveMessage', { QueueUrl: URL_, ...input }, caller()))).type).toBe('InvalidParameterValue');
      }
    });
  });

  describe('DeleteMessage and ChangeMessageVisibility', () => {
    const handle = receiptHandle({ id: '101', receiveCount: 1, messageId: '6b5a8a52-6f0b-4c3e-9d4e-3c4b8f1e2a01' });

    it("deletes the message its receipt handle names, and refuses a handle no receive gave", async () => {
      const { operations, queues } = setup();
      await expect(operations.run('DeleteMessage', { QueueUrl: URL_, ReceiptHandle: handle }, caller())).resolves.toEqual({});
      expect(queues.deleteMessages).toHaveBeenCalledWith(ORDERS, [parseReceiptHandle(handle)]);
      expect(await refusal(operations.run('DeleteMessage', { QueueUrl: URL_, ReceiptHandle: 'made-up' }, caller()))).toMatchObject({
        type: 'ReceiptHandleIsInvalid',
        message: 'The input receipt handle "made-up" is not a valid receipt handle.',
      });
    });

    it('answers each entry of a batch, a failed one beside the others', async () => {
      const { operations } = setup();
      await expect(
        operations.run('DeleteMessageBatch', { QueueUrl: URL_, Entries: [{ Id: 'a', ReceiptHandle: handle }, { Id: 'b', ReceiptHandle: 'made-up' }] }, caller()),
      ).resolves.toEqual({
        Successful: [{ Id: 'a' }],
        Failed: [{ Id: 'b', Code: 'ReceiptHandleIsInvalid', SenderFault: true, Message: 'The input receipt handle "made-up" is not a valid receipt handle.' }],
      });
    });

    it('changes a received message\'s visibility, and answers MessageNotInflight for one not received any more', async () => {
      const { operations, queues } = setup();
      await expect(operations.run('ChangeMessageVisibility', { QueueUrl: URL_, ReceiptHandle: handle, VisibilityTimeout: 120 }, caller())).resolves.toEqual({});
      expect(queues.changeVisibility).toHaveBeenCalledWith(ORDERS, parseReceiptHandle(handle), 120, expect.any(Date));
      queues.changeVisibility.mockResolvedValue(false);
      expect((await refusal(operations.run('ChangeMessageVisibility', { QueueUrl: URL_, ReceiptHandle: handle, VisibilityTimeout: 120 }, caller()))).type).toBe('MessageNotInflight');
      expect((await refusal(operations.run('ChangeMessageVisibility', { QueueUrl: URL_, ReceiptHandle: handle }, caller()))).type).toBe('MissingParameter');
    });
  });

  describe("a key's reach", () => {
    const naming = (queues: string[] | null, buckets: string[] | null = null) => caller({ reach: { buckets, queues } });

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

    it('lets a key that names buckets alone reach no queue, and one that names neither every one', async () => {
      const { operations } = setup();
      expect((await refusal(operations.run('GetQueueUrl', { QueueName: 'orders' }, naming(null, ['photos'])))).type).toBe('AccessDenied');
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
      await refusal(operations.run('SendMessage', { QueueUrl: URL_, MessageBody: 'x' }, noting({ reach: { buckets: null, queues: ['invoices'] } })));
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

      expect(counts.count.mock.calls).toEqual([[counted()], [counted({ queueName: 'invoices' })]]);
    });
  });

  it("answers ListQueues' URLs, and GetQueueAttributes' counts", async () => {
    const { operations, queues } = setup();
    await expect(operations.run('ListQueues', { QueueNamePrefix: 'ord', MaxResults: 5 }, caller())).resolves.toEqual({ QueueUrls: [URL_] });
    expect(queues.list).toHaveBeenCalledWith(ACCOUNT, 'ord', 5, undefined);
    await expect(operations.run('GetQueueAttributes', { QueueUrl: URL_, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }, caller())).resolves.toEqual({
      Attributes: { ApproximateNumberOfMessages: '3', ApproximateNumberOfMessagesNotVisible: '2' },
    });
  });
});

import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { onePlan } from '../plans/test-fixtures';
import { Queue, QueueKind } from './queue.entity';
import { QueuesService } from './queues.service';
import { DEFAULT_SETTINGS } from './sqs-attributes';
import { SqsError, accessDenied, internalError, invalidParameter, overLimit, queueDoesNotExist } from './sqs-error';

const ACCOUNT = '000000000001';
const BASE = 'https://sqs.ffunc.tn';
const URL_ = `${BASE}/${ACCOUNT}/orders`;
const ORDERS: Queue = Object.assign(new Queue(), {
  id: 'queue-orders',
  accountId: ACCOUNT,
  name: 'orders',
  kind: QueueKind.CUSTOMER,
  functionId: null,
  sizeBytes: '2048',
  ...DEFAULT_SETTINGS,
  redrivePolicy: { deadLetterTargetArn: `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:orders-dlq`, maxReceiveCount: 5 },
  createdAt: new Date('2026-10-23T08:00:00Z'),
  updatedAt: new Date('2026-10-23T09:00:00Z'),
});
const user: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer', userId: 'u-1' };

describe("QueuesService: customers' queues in FF's API, as SQS's operations (L1)", () => {
  let operations: { run: jest.Mock };
  let queues: { find: jest.Mock; list: jest.Mock; counts: jest.Mock; countsOf: jest.Mock };
  let credit: { admit: jest.Mock };
  let account: { storageDisabledAt: Date | null; storageDisabledReason: string | null };
  let service: QueuesService;

  beforeEach(() => {
    operations = { run: jest.fn(async () => ({})) };
    queues = {
      find: jest.fn(async (_account: string, name: string) => (name === 'orders' ? ORDERS : null)),
      list: jest.fn(async () => ({ queues: [ORDERS] })),
      counts: jest.fn(async () => ({ visible: 3, notVisible: 1, delayed: 0 })),
      countsOf: jest.fn(async () => new Map([[ORDERS.id, { visible: 3, notVisible: 1, delayed: 0 }]])),
    };
    credit = { admit: jest.fn(async () => undefined) };
    account = { storageDisabledAt: null, storageDisabledReason: null };
    service = new QueuesService(
      operations as never,
      queues as never,
      onePlan(),
      credit as never,
      { account: async () => account } as never,
      new ConfigService({ sqs: { base: BASE, region: 'tn-tunis-1' } }),
    );
  });

  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 'done',
      (error: HttpException) => [error.getStatus(), (error.getResponse() as { message: string }).message],
    );

  it("answers each queue with its URL, ARN, SQS's attributes and its messages counted", async () => {
    expect(await service.list(ACCOUNT)).toEqual([
      {
        name: 'orders',
        url: URL_,
        arn: `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:orders`,
        visibilityTimeout: 30,
        messageRetentionPeriod: 345_600,
        delaySeconds: 0,
        maximumMessageSize: 1_048_576,
        receiveMessageWaitTimeSeconds: 0,
        redrivePolicy: { deadLetterTargetArn: `arn:aws:sqs:tn-tunis-1:${ACCOUNT}:orders-dlq`, maxReceiveCount: 5 },
        messages: { available: 3, inFlight: 1, delayed: 0 },
        sizeBytes: 2048,
        createdAt: ORDERS.createdAt,
        updatedAt: ORDERS.updatedAt,
      },
    ]);
    expect(queues.countsOf).toHaveBeenCalledWith(ACCOUNT, expect.any(Date));
    expect(await status(service.get(ACCOUNT, 'invoices'))).toEqual([404, 'The account has no queue named "invoices"']);
  });

  it("makes a queue as SQS's CreateQueue, its attributes as SQS writes them, as the caller, and answers it; a name the account has, 409", async () => {
    queues.find.mockResolvedValueOnce(null);
    await service.create(user, { name: 'orders', visibilityTimeout: 60, redrivePolicy: { deadLetterTargetArn: 'arn:aws:sqs:tn-tunis-1:000000000001:dlq', maxReceiveCount: 3 } });

    expect(operations.run).toHaveBeenCalledWith(
      'CreateQueue',
      { QueueName: 'orders', Attributes: { VisibilityTimeout: '60', RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:tn-tunis-1:000000000001:dlq","maxReceiveCount":3}' } },
      { accountId: ACCOUNT, keyId: 'user:u-1', readOnly: false, plan: expect.objectContaining({ id: 'beta' }), endpoint: BASE, signal: undefined },
    );
    expect(await status(service.create(user, { name: 'orders' }))).toEqual([409, 'The account has a queue named "orders" already']);
  });

  it("answers SQS's errors as HTTP's: the plan's queues 400, a value refused 400 naming SQS's error, a key's denial 403", async () => {
    queues.find.mockResolvedValue(null);
    operations.run.mockRejectedValueOnce(overLimit('The Beta plan allows 10 queues per account: delete one first.'));
    expect(await status(service.create(user, { name: 'many' }))).toEqual([400, 'The Beta plan allows 10 queues per account: delete one first.']);
    operations.run.mockRejectedValueOnce(invalidParameter('Value for parameter RedrivePolicy is invalid.'));
    expect(await status(service.create(user, { name: 'bad' }))).toEqual([400, 'InvalidParameterValue: Value for parameter RedrivePolicy is invalid.']);
    operations.run.mockRejectedValueOnce(accessDenied('no'));
    expect(await status(service.create(user, { name: 'denied' }))).toEqual([403, 'no']);
    operations.run.mockRejectedValueOnce(new SqsError(400, 'QueueNameExists', 'A queue already exists', 'QueueAlreadyExists'));
    await expect(service.create(user, { name: 'raced' })).rejects.toBeInstanceOf(ConflictException);
    operations.run.mockRejectedValueOnce(internalError());
    await expect(service.create(user, { name: 'broken' })).rejects.toBeInstanceOf(SqsError);
  });

  it("changes what is given, a redrive policy of null removed, as SetQueueAttributes; a queue gone meanwhile, 404", async () => {
    await service.update(user, 'orders', { delaySeconds: 10, redrivePolicy: null });

    expect(operations.run).toHaveBeenCalledWith('SetQueueAttributes', { QueueUrl: URL_, Attributes: { DelaySeconds: '10', RedrivePolicy: '' } }, expect.anything());
    operations.run.mockRejectedValueOnce(queueDoesNotExist());
    expect(await status(service.update(user, 'orders', {}))).toEqual([404, 'The account has no queue named "orders"']);
    expect(await status(service.remove(user, 'invoices'))).toEqual([404, 'The account has no queue named "invoices"']);
  });

  it("sends as SendMessage, with the account's credit, its attributes as SQS's, the plan's room 429, the API key the sender", async () => {
    operations.run.mockResolvedValueOnce({ MessageId: 'm-1', MD5OfMessageBody: 'md5' });
    const key: Principal = { ...user, userId: undefined, keyId: '0123456789ab' };

    expect(await service.send(key, 'orders', { body: 'hello', delaySeconds: 5, attributes: { item: { dataType: 'String', stringValue: 'harissa' } } })).toEqual({ messageId: 'm-1', md5OfBody: 'md5' });
    expect(credit.admit).toHaveBeenCalledWith(ACCOUNT);
    expect(operations.run).toHaveBeenCalledWith(
      'SendMessage',
      { QueueUrl: URL_, MessageBody: 'hello', MessageAttributes: { item: { DataType: 'String', StringValue: 'harissa', BinaryValue: undefined } }, DelaySeconds: 5 },
      expect.objectContaining({ keyId: '0123456789ab' }),
    );
    operations.run.mockRejectedValueOnce(overLimit("The account's messages hold 100 MB together"));
    expect(await status(service.send(user, 'orders', { body: 'hello' }))).toEqual([429, "The account's messages hold 100 MB together"]);
  });

  it("receives as ReceiveMessage, every attribute asked for, and answers each message with its handle, its sender and when it was sent", async () => {
    operations.run.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: 'm-1',
          ReceiptHandle: 'handle-1',
          Body: 'hello',
          Attributes: { SenderId: 'AKFF7Q2MLKX4RTZB3W5N', SentTimestamp: String(Date.parse('2026-10-23T10:00:00Z')), ApproximateReceiveCount: '2' },
          MessageAttributes: { item: { DataType: 'String', StringValue: 'harissa' }, picture: { DataType: 'Binary', BinaryValue: 'AAEC' } },
        },
      ],
    });

    expect(await service.receive(user, 'orders', { maxMessages: 10, waitTimeSeconds: 2 })).toEqual([
      {
        messageId: 'm-1',
        receiptHandle: 'handle-1',
        body: 'hello',
        attributes: { item: { dataType: 'String', stringValue: 'harissa' }, picture: { dataType: 'Binary', binaryValue: 'AAEC' } },
        receiveCount: 2,
        senderId: 'AKFF7Q2MLKX4RTZB3W5N',
        sentAt: new Date('2026-10-23T10:00:00Z'),
      },
    ]);
    expect(operations.run).toHaveBeenCalledWith(
      'ReceiveMessage',
      { QueueUrl: URL_, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] },
      expect.anything(),
    );
    operations.run.mockResolvedValueOnce({});
    expect(await service.receive(user, 'orders', {})).toEqual([]);
  });

  it("makes, sends and receives nothing while FF has the account's queues off, and goes on deleting", async () => {
    account = { storageDisabledAt: new Date(), storageDisabledReason: 'unpaid invoice' };
    const off = [403, "FF turned this account's databases, buckets and queues off: unpaid invoice"];

    expect(await status(service.create(user, { name: 'invoices' }))).toEqual(off);
    expect(await status(service.send(user, 'orders', { body: 'x' }))).toEqual(off);
    expect(await status(service.receive(user, 'orders', {}))).toEqual(off);
    await expect(service.purge(user, 'orders')).resolves.toBeUndefined();
    await expect(service.deleteMessage(user, 'orders', 'handle-1')).resolves.toBeUndefined();
    await expect(service.remove(user, 'orders')).resolves.toBeUndefined();
    expect(operations.run.mock.calls.map(([operation]) => operation)).toEqual(['PurgeQueue', 'DeleteMessage', 'DeleteQueue']);
  });

  it('answers a receipt handle no receive gave as 400, in SQS\'s words', async () => {
    operations.run.mockRejectedValueOnce(new SqsError(400, 'ReceiptHandleIsInvalid', 'The input receipt handle "x" is not a valid receipt handle.'));

    await expect(service.deleteMessage(user, 'orders', 'x')).rejects.toEqual(new BadRequestException('ReceiptHandleIsInvalid: The input receipt handle "x" is not a valid receipt handle.'));
  });
});

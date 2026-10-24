import { Queue, QueueKind } from './queue.entity';
import { DEFAULT_SETTINGS, attributesOf, checkQueueName, differentSetting, parseQueueArn, queueArn, settingsOf } from './sqs-attributes';
import { SqsError } from './sqs-error';

const REGION = 'tn-tunis-1';
const ACCOUNT = '000000000001';
const DLQ = queueArn(REGION, ACCOUNT, 'orders-dlq');

function refusal(check: () => unknown): { type: string; message: string } {
  try {
    check();
  } catch (error) {
    if (error instanceof SqsError) return { type: error.type, message: error.message };
    throw error;
  }
  throw new Error('not refused');
}

const queue = (settings: Partial<Queue> = {}): Queue =>
  Object.assign(new Queue(), {
    id: 'queue-1',
    accountId: ACCOUNT,
    name: 'orders',
    kind: QueueKind.CUSTOMER,
    functionId: null,
    sizeBytes: '0',
    ...DEFAULT_SETTINGS,
    createdAt: new Date('2026-10-23T08:00:00.900Z'),
    updatedAt: new Date('2026-10-23T09:30:00Z'),
    ...settings,
  });

describe("SQS's queue attributes", () => {
  it("names a queue by its ARN, in FF's region, under its account", () => {
    expect(DLQ).toBe('arn:aws:sqs:tn-tunis-1:000000000001:orders-dlq');
    expect(parseQueueArn(DLQ)).toEqual({ region: REGION, accountId: ACCOUNT, name: 'orders-dlq' });
    for (const arn of ['arn:aws:sns:tn-tunis-1:000000000001:topic', 'arn:aws:sqs:tn-tunis-1:1:orders', 'orders']) expect(parseQueueArn(arn)).toBeUndefined();
  });

  it("takes SQS's queue names, and refuses FIFO queues' for now", () => {
    expect(checkQueueName('orders_2-eu')).toBe('orders_2-eu');
    expect(refusal(() => checkQueueName('orders.fifo')).message).toBe("FF's queues are standard queues: FIFO queues come later.");
    expect(refusal(() => checkQueueName('a'.repeat(81))).type).toBe('InvalidParameterValue');
    expect(refusal(() => checkQueueName('with space')).type).toBe('InvalidParameterValue');
    expect(refusal(() => checkQueueName(undefined)).type).toBe('MissingParameter');
  });

  describe('the settings an Attributes map sets', () => {
    it("reads each as SQS takes it, a string in its range", () => {
      expect(
        settingsOf(
          { VisibilityTimeout: '60', MessageRetentionPeriod: '86400', DelaySeconds: '5', MaximumMessageSize: '2048', ReceiveMessageWaitTimeSeconds: '20', SqsManagedSseEnabled: 'false' },
          REGION,
          ACCOUNT,
        ),
      ).toEqual({ visibilityTimeout: 60, messageRetentionSeconds: 86_400, delaySeconds: 5, maximumMessageSize: 2048, receiveWaitSeconds: 20 });
      expect(settingsOf(undefined, REGION, ACCOUNT)).toEqual({});
    });

    it('refuses a value out of its range, or not a whole number', () => {
      for (const attributes of [{ VisibilityTimeout: '43201' }, { MessageRetentionPeriod: '59' }, { DelaySeconds: '1.5' }, { MaximumMessageSize: '1048577' }, { ReceiveMessageWaitTimeSeconds: '-1' }, { DelaySeconds: 5 }]) {
        expect(refusal(() => settingsOf(attributes, REGION, ACCOUNT)).type).toBe('InvalidAttributeValue');
      }
    });

    it("refuses what FF's queues don't do, saying why, and names SQS doesn't know", () => {
      expect(refusal(() => settingsOf({ FifoQueue: 'true' }, REGION, ACCOUNT))).toEqual({
        type: 'InvalidAttributeName',
        message: "FF's queues are standard queues: FIFO queues come later: FifoQueue is not taken.",
      });
      expect(refusal(() => settingsOf({ Policy: '{}' }, REGION, ACCOUNT)).type).toBe('InvalidAttributeName');
      expect(refusal(() => settingsOf({ KmsMasterKeyId: 'alias/aws/sqs' }, REGION, ACCOUNT)).type).toBe('InvalidAttributeName');
      expect(refusal(() => settingsOf({ SqsManagedSseEnabled: 'true' }, REGION, ACCOUNT)).type).toBe('InvalidAttributeValue');
      expect(refusal(() => settingsOf({ QueueArn: DLQ }, REGION, ACCOUNT))).toEqual({ type: 'InvalidAttributeName', message: 'Unknown Attribute QueueArn.' });
    });

    it("reads a redrive policy: another queue of the account's, in FF's region, after 1 to 1000 receives; '' removes it", () => {
      expect(settingsOf({ RedrivePolicy: JSON.stringify({ deadLetterTargetArn: DLQ, maxReceiveCount: '5' }) }, REGION, ACCOUNT)).toEqual({
        redrivePolicy: { deadLetterTargetArn: DLQ, maxReceiveCount: 5 },
      });
      expect(settingsOf({ RedrivePolicy: '' }, REGION, ACCOUNT)).toEqual({ redrivePolicy: null });
      const refused = (policy: string) => refusal(() => settingsOf({ RedrivePolicy: policy }, REGION, ACCOUNT)).message;
      expect(refused('not json')).toBe('Value for parameter RedrivePolicy is invalid. Reason: Redrive policy is not a valid JSON map.');
      expect(refused(JSON.stringify({ deadLetterTargetArn: queueArn(REGION, '000000000002', 'theirs'), maxReceiveCount: 5 }))).toBe(
        "Value for parameter RedrivePolicy is invalid. Reason: The dead-letter queue must be the account's, in tn-tunis-1.",
      );
      expect(refused(JSON.stringify({ deadLetterTargetArn: queueArn('us-east-1', ACCOUNT, 'dlq'), maxReceiveCount: 5 }))).toContain("must be the account's");
      expect(refused(JSON.stringify({ deadLetterTargetArn: DLQ, maxReceiveCount: 0 }))).toContain('maxReceiveCount must be a number from 1 to 1000');
      expect(refused(JSON.stringify({ maxReceiveCount: 5 }))).toContain('Invalid value for deadLetterTargetArn');
    });
  });

  describe("a queue there is, made again: SQS's CreateQueue", () => {
    it('is the same queue when the attributes given have its values', () => {
      expect(differentSetting(queue(), {})).toBeUndefined();
      expect(differentSetting(queue({ visibilityTimeout: 60 }), { visibilityTimeout: 60 })).toBeUndefined();
    });

    it('names the first attribute given that has another value', () => {
      expect(differentSetting(queue(), { visibilityTimeout: 60 })).toBe('VisibilityTimeout');
      expect(differentSetting(queue(), { redrivePolicy: { deadLetterTargetArn: DLQ, maxReceiveCount: 5 } })).toBe('RedrivePolicy');
    });

    it("compares redrive policies field by field: the database's JSON keeps its keys in its own order", () => {
      const kept = JSON.parse('{"maxReceiveCount": 5, "deadLetterTargetArn": "' + DLQ + '"}') as Queue['redrivePolicy'];
      expect(differentSetting(queue({ redrivePolicy: kept }), { redrivePolicy: { deadLetterTargetArn: DLQ, maxReceiveCount: 5 } })).toBeUndefined();
      expect(differentSetting(queue({ redrivePolicy: kept }), { redrivePolicy: { deadLetterTargetArn: DLQ, maxReceiveCount: 6 } })).toBe('RedrivePolicy');
    });
  });

  describe("GetQueueAttributes' answer", () => {
    const counts = { visible: 3, notVisible: 2, delayed: 1 };

    it("is every attribute for All, each a string as SQS writes it, the redrive policy's dead-letter queue first", () => {
      const kept = JSON.parse('{"maxReceiveCount": 5, "deadLetterTargetArn": "' + DLQ + '"}') as Queue['redrivePolicy'];
      expect(attributesOf(queue({ redrivePolicy: kept }), counts, ['All'], REGION)).toEqual({
        QueueArn: 'arn:aws:sqs:tn-tunis-1:000000000001:orders',
        ApproximateNumberOfMessages: '3',
        ApproximateNumberOfMessagesNotVisible: '2',
        ApproximateNumberOfMessagesDelayed: '1',
        CreatedTimestamp: '1792742400',
        LastModifiedTimestamp: '1792747800',
        VisibilityTimeout: '30',
        MessageRetentionPeriod: '345600',
        DelaySeconds: '0',
        MaximumMessageSize: '1048576',
        ReceiveMessageWaitTimeSeconds: '0',
        SqsManagedSseEnabled: 'false',
        RedrivePolicy: `{"deadLetterTargetArn":"${DLQ}","maxReceiveCount":5}`,
      });
    });

    it("is those asked for by name, none when none are asked for, and refuses a name SQS doesn't know", () => {
      expect(attributesOf(queue(), counts, ['ApproximateNumberOfMessages', 'QueueArn'], REGION)).toEqual({
        ApproximateNumberOfMessages: '3',
        QueueArn: 'arn:aws:sqs:tn-tunis-1:000000000001:orders',
      });
      expect(attributesOf(queue(), counts, undefined, REGION)).toEqual({});
      expect(attributesOf(queue(), counts, ['RedrivePolicy'], REGION)).toEqual({});
      expect(refusal(() => attributesOf(queue(), counts, ['Colour'], REGION))).toEqual({ type: 'InvalidAttributeName', message: 'Unknown Attribute Colour.' });
    });
  });
});

import { Received } from '../queues/customer-queues';
import { attributesMd5, md5Hex, parseReceiptHandle } from '../queues/sqs-messages';
import { EVENT_ENVELOPE_BYTES, failedMessages, recordBytes, sqsRecord } from './sqs-event';

const ARN = 'arn:aws:sqs:tn-tunis-1:000000000001:orders';
const message = (values: Partial<Received> = {}): Received => ({
  id: '42',
  messageId: '7e4d1c2a-0000-4000-8000-000000000001',
  body: '{"order": 42}',
  meta: { senderId: 'AKFF7Q2MLKX4RTZB3W5N' },
  sentAt: new Date('2026-10-24T08:00:00.000Z'),
  receiveCount: 2,
  firstReceivedAt: new Date('2026-10-24T08:00:01.500Z'),
  ...values,
});

describe("SQS's event, as AWS Lambda gives a function that reads a queue", () => {
  it("gives each message as Lambda's record: SQS's system attributes as strings, the body's MD5, the queue's ARN and region", () => {
    const record = sqsRecord(message(), ARN, 'tn-tunis-1');

    expect(record).toEqual({
      messageId: '7e4d1c2a-0000-4000-8000-000000000001',
      receiptHandle: expect.any(String),
      body: '{"order": 42}',
      attributes: {
        ApproximateReceiveCount: '2',
        SentTimestamp: String(Date.parse('2026-10-24T08:00:00.000Z')),
        SenderId: 'AKFF7Q2MLKX4RTZB3W5N',
        ApproximateFirstReceiveTimestamp: String(Date.parse('2026-10-24T08:00:01.500Z')),
      },
      messageAttributes: {},
      md5OfBody: md5Hex('{"order": 42}'),
      eventSource: 'aws:sqs',
      eventSourceARN: ARN,
      awsRegion: 'tn-tunis-1',
    });
    // Its receipt handle is this receive's, which DeleteMessage takes, as a function may delete a message itself.
    expect(parseReceiptHandle(record.receiptHandle)).toEqual({ id: '42', receiveCount: 2, messageId: '7e4d1c2a-0000-4000-8000-000000000001' });
    // Lambda's own keys, in its order.
    expect(Object.keys(record)).toEqual(['messageId', 'receiptHandle', 'body', 'attributes', 'messageAttributes', 'md5OfBody', 'eventSource', 'eventSourceARN', 'awsRegion']);
  });

  it("gives message attributes in Lambda's shape, with SQS's empty lists, their MD5, and a trace header among the system attributes", () => {
    const messageAttributes = {
      item: { DataType: 'String', StringValue: 'harissa' },
      picture: { DataType: 'Binary.png', BinaryValue: 'AAEC' },
    };
    const trace = { DataType: 'String', StringValue: 'Root=1-5759e988-bd862e3fe1be46a994272793' };
    const record = sqsRecord(message({ meta: { senderId: 'AKFF7Q2MLKX4RTZB3W5N', messageAttributes, systemAttributes: { AWSTraceHeader: trace } } }), ARN, 'tn-tunis-1');

    expect(record.messageAttributes).toEqual({
      item: { stringValue: 'harissa', stringListValues: [], binaryListValues: [], dataType: 'String' },
      picture: { binaryValue: 'AAEC', stringListValues: [], binaryListValues: [], dataType: 'Binary.png' },
    });
    expect(record.md5OfMessageAttributes).toBe(attributesMd5(messageAttributes));
    expect(record.attributes).toMatchObject({ AWSTraceHeader: 'Root=1-5759e988-bd862e3fe1be46a994272793', SenderId: 'AKFF7Q2MLKX4RTZB3W5N' });
  });

  it('counts what each record adds to the event as JSON, its comma with it', () => {
    const one = sqsRecord(message(), ARN, 'tn-tunis-1');
    const two = sqsRecord(message({ id: '43', messageId: '7e4d1c2a-0000-4000-8000-000000000002' }), ARN, 'tn-tunis-1');

    expect(EVENT_ENVELOPE_BYTES + recordBytes(one) + recordBytes(two) - 1).toBe(Buffer.byteLength(JSON.stringify({ Records: [one, two] })));
  });
});

describe("a call's answer, as Lambda reads a partial batch response", () => {
  const ids = new Set(['m-1', 'm-2', 'm-3']);

  it('names no failure for no answer, an empty one, or an empty or null list', () => {
    for (const output of [null, undefined, {}, { batchItemFailures: [] }, { batchItemFailures: null }, { other: 1 }]) {
      expect(failedMessages(output, ids)).toEqual(new Set());
    }
  });

  it('names the messages the answer names, by their IDs', () => {
    expect(failedMessages({ batchItemFailures: [{ itemIdentifier: 'm-2' }, { itemIdentifier: 'm-3' }] }, ids)).toEqual(new Set(['m-2', 'm-3']));
  });

  it("takes the whole batch as failed for an answer Lambda can't read as one: not an object, a list that isn't one, an ID empty, null, misnamed or not the batch's", () => {
    for (const output of [
      'done',
      42,
      [{ itemIdentifier: 'm-1' }],
      { batchItemFailures: 'm-1' },
      { batchItemFailures: [{ itemIdentifier: '' }] },
      { batchItemFailures: [{ itemIdentifier: null }] },
      { batchItemFailures: [{ id: 'm-1' }] },
      { batchItemFailures: [null] },
      { batchItemFailures: [{ itemIdentifier: 'm-1' }, { itemIdentifier: 'not-in-the-batch' }] },
    ]) {
      expect(failedMessages(output, ids)).toBe('all');
    }
  });
});

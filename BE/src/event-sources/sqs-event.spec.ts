/**
 * SQS's event as Lambda gives it, and a call's answer as Lambda reads it. The
 * messages, their records and the answers are sqs-event-examples.json's,
 * which ff local's event source mappings read too; what only JavaScript can
 * hold, an answer of nothing, is here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Received } from '../queues/customer-queues';
import { MessageAttribute, attributesMd5, md5Hex, parseReceiptHandle } from '../queues/sqs-messages';
import { EVENT_ENVELOPE_BYTES, SqsRecord, failedMessages, recordBytes, sqsRecord } from './sqs-event';

/** A message as sqs-event-examples.json writes it: as the queue keeps it, its times as text. */
interface Held {
  id: string;
  messageId: string;
  body: string;
  meta: Received['meta'];
  sentAt: string;
  receiveCount: number;
  firstReceivedAt: string;
}

interface Examples {
  queueArn: string;
  region: string;
  order: string[];
  records: Record<'asSent' | 'withAttributes', { title: string; message: Held; record: SqsRecord }>;
  batchResponses: { batch: string[]; none: unknown[]; named: Array<{ output: unknown; failed: string[] }>; all: unknown[] };
}

const table = JSON.parse(readFileSync(join(__dirname, 'sqs-event-examples.json'), 'utf8')) as Examples;
const { queueArn: ARN, region: REGION } = table;

const received = (held: Held, values: Partial<Received> = {}): Received => ({
  ...held,
  sentAt: new Date(held.sentAt),
  firstReceivedAt: new Date(held.firstReceivedAt),
  sizeBytes: Buffer.byteLength(held.body),
  ...values,
});

describe("SQS's event, as AWS Lambda gives a function that reads a queue", () => {
  it("gives each message as Lambda's record: SQS's system attributes as strings, the body's MD5, the queue's ARN and region", () => {
    const { message, record: expected } = table.records.asSent;
    const record = sqsRecord(received(message), ARN, REGION);

    expect(record).toEqual(expected);
    expect(record.md5OfBody).toBe(md5Hex(message.body));
    // Its receipt handle is this receive's, which DeleteMessage takes, as a function may delete a message itself.
    expect(parseReceiptHandle(record.receiptHandle)).toEqual({ id: message.id, receiveCount: message.receiveCount, messageId: message.messageId });
    // Lambda's own keys, in its order.
    expect(Object.keys(record)).toEqual(table.order.filter((key) => key in expected));
  });

  it("gives message attributes in Lambda's shape, with SQS's empty lists, their MD5, and a trace header among the system attributes", () => {
    const { message, record: expected } = table.records.withAttributes;
    const record = sqsRecord(received(message), ARN, REGION);

    expect(record).toEqual(expected);
    expect(record.md5OfMessageAttributes).toBe(attributesMd5(message.meta.messageAttributes as Record<string, MessageAttribute>));
    expect(Object.keys(record)).toEqual(table.order);
  });

  it('counts what each record adds to the event as JSON, its comma with it', () => {
    const { message } = table.records.asSent;
    const one = sqsRecord(received(message), ARN, REGION);
    const two = sqsRecord(received(message, { id: '43', messageId: '7e4d1c2a-0000-4000-8000-000000000002' }), ARN, REGION);

    expect(EVENT_ENVELOPE_BYTES + recordBytes(one) + recordBytes(two) - 1).toBe(Buffer.byteLength(JSON.stringify({ Records: [one, two] })));
  });
});

describe("a call's answer, as Lambda reads a partial batch response", () => {
  const { batch, none, named, all } = table.batchResponses;
  const ids = new Set(batch);

  it('names no failure for no answer, an empty one, or an empty or null list', () => {
    for (const output of [undefined, ...none]) {
      expect(failedMessages(output, ids)).toEqual(new Set());
    }
  });

  it('names the messages the answer names, by their IDs', () => {
    for (const { output, failed } of named) {
      expect(failedMessages(output, ids)).toEqual(new Set(failed));
    }
  });

  it("takes the whole batch as failed for an answer Lambda can't read as one: not an object, a list that isn't one, an ID empty, null, misnamed or not the batch's", () => {
    for (const output of all) {
      expect(failedMessages(output, ids)).toBe('all');
    }
  });
});

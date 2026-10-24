import { Received } from '../queues/customer-queues';
import { MessageAttribute, attributesMd5, md5Hex, receiptHandle } from '../queues/sqs-messages';

/** A message attribute as Lambda's SQS event gives it: its value, the lists SQS keeps empty, and its type. */
export interface SqsRecordAttribute {
  stringValue?: string;
  binaryValue?: string;
  stringListValues: string[];
  binaryListValues: string[];
  dataType: string;
}

/** One message of a batch, as AWS Lambda gives it to a function that reads an SQS queue. */
export interface SqsRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, string>;
  messageAttributes: Record<string, SqsRecordAttribute>;
  md5OfBody: string;
  md5OfMessageAttributes?: string;
  eventSource: 'aws:sqs';
  eventSourceARN: string;
  awsRegion: string;
}

/** SQS's event: the batch's messages, oldest first. */
export interface SqsEvent {
  Records: SqsRecord[];
}

/** The batch's message, as Lambda's record: SQS's system attributes as strings, its message attributes in Lambda's shape. */
export function sqsRecord(message: Received, queueArn: string, region: string): SqsRecord {
  const attributes: Record<string, string> = {
    ApproximateReceiveCount: String(message.receiveCount),
    SentTimestamp: String(message.sentAt.getTime()),
    SenderId: message.meta.senderId ?? '',
    ApproximateFirstReceiveTimestamp: String(message.firstReceivedAt.getTime()),
  };
  const trace = message.meta.systemAttributes?.AWSTraceHeader?.StringValue;
  if (trace) attributes.AWSTraceHeader = trace;
  const sent: Record<string, MessageAttribute> = message.meta.messageAttributes ?? {};
  const messageAttributes = Object.fromEntries(
    Object.entries(sent).map(([name, value]): [string, SqsRecordAttribute] => [
      name,
      {
        ...(value.StringValue !== undefined ? { stringValue: value.StringValue } : {}),
        ...(value.BinaryValue !== undefined ? { binaryValue: value.BinaryValue } : {}),
        stringListValues: [],
        binaryListValues: [],
        dataType: value.DataType,
      },
    ]),
  );
  const md5OfMessageAttributes = attributesMd5(sent);
  return {
    messageId: message.messageId,
    receiptHandle: receiptHandle({ id: message.id, receiveCount: message.receiveCount, messageId: message.messageId }),
    body: message.body,
    attributes,
    messageAttributes,
    md5OfBody: md5Hex(message.body),
    ...(md5OfMessageAttributes ? { md5OfMessageAttributes } : {}),
    eventSource: 'aws:sqs',
    eventSourceARN: queueArn,
    awsRegion: region,
  };
}

/** What `{"Records":[]}` takes as JSON, and what each record adds to it with its comma. */
export const EVENT_ENVELOPE_BYTES = Buffer.byteLength('{"Records":[]}');
export const recordBytes = (record: SqsRecord): number => Buffer.byteLength(JSON.stringify(record)) + 1;

/**
 * The messages a call's answer names as failed, as Lambda reads a partial
 * batch response (ReportBatchItemFailures): none for no answer, an empty one,
 * or an empty or null `batchItemFailures`; `all` for an answer that isn't
 * one, or a failure that names no message of the batch, as Lambda takes the
 * whole batch as failed then.
 */
export function failedMessages(output: unknown, messageIds: ReadonlySet<string>): Set<string> | 'all' {
  if (output === null || output === undefined) return new Set();
  if (typeof output !== 'object' || Array.isArray(output)) return 'all';
  const failures = (output as Record<string, unknown>).batchItemFailures;
  if (failures === undefined || failures === null) return new Set();
  if (!Array.isArray(failures)) return 'all';
  const failed = new Set<string>();
  for (const failure of failures as unknown[]) {
    const id = failure !== null && typeof failure === 'object' ? (failure as Record<string, unknown>).itemIdentifier : undefined;
    if (typeof id !== 'string' || !messageIds.has(id)) return 'all';
    failed.add(id);
  }
  return failed;
}

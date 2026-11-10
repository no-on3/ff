import { randomBytes } from 'node:crypto';
import type { MessageAttribute } from '../queues/sqs-messages';

/**
 * One request's trail across functions: a trace ID in AWS X-Ray's format, `1-<the time, in seconds, 8 hex
 * digits>-<24 hex digits drawn at random>`, the one AWS Lambda gives a call in `_X_AMZN_TRACE_ID`, so that code
 * and tools that read it there read it here. A call takes it from its caller's X-Amzn-Trace-Id, or from a queue
 * message's AWSTraceHeader, as Lambda does; else its entry starts a new one.
 */

/** The request header that carries a trace, as API Gateway, Lambda's function URLs and the AWS SDKs send it. */
export const TRACE_HEADER = 'x-amzn-trace-id';

/** The system attribute of a queue message that carries a trace, as SQS keeps it. */
export const TRACE_ATTRIBUTE = 'AWSTraceHeader';

const TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

/** Whether `id` is a trace ID in X-Ray's format, in lower case. */
export function isTraceId(id: string): boolean {
  return TRACE_ID.test(id);
}

/** A new trace ID: the time now, in seconds, and 96 bits drawn at random. */
export function newTraceId(now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000).toString(16).padStart(8, '0').slice(-8);
  return `1-${seconds}-${randomBytes(12).toString('hex')}`;
}

/**
 * The trace a header names: its Root field's, as X-Ray writes one (`Root=1-…;Parent=…;Sampled=1`), its fields in
 * any order, their names in any case; undefined when it names none in X-Ray's format.
 */
export function traceRoot(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  for (const field of value.split(';')) {
    const equals = field.indexOf('=');
    if (equals < 0 || field.slice(0, equals).trim().toLowerCase() !== 'root') continue;
    const root = field.slice(equals + 1).trim().toLowerCase();
    return isTraceId(root) ? root : undefined;
  }
  return undefined;
}

/** A call's trace: the one its caller's header names, else a new one. */
export function traceOf(header: string | string[] | undefined): string {
  return traceRoot(header) ?? newTraceId();
}

/** The header that names `traceId`, as an answer gives it back and a message carries it. */
export function rootHeader(traceId: string): string {
  return `Root=${traceId}`;
}

/** What an asynchronous call's queue keeps beside its event: its trace, which each attempt and its record keep. */
export function traceAttributes(traceId: string): { trace: string } {
  return { trace: traceId };
}

/** The trace an asynchronous call's event kept, if any: one kept before calls had traces has none. */
export function traceOfAttributes(attributes: Record<string, unknown> | null | undefined): string | undefined {
  const trace = attributes?.trace;
  return typeof trace === 'string' && isTraceId(trace) ? trace : undefined;
}

/** A queue message's system attributes carrying `traceId`, as SQS keeps a message's AWSTraceHeader. */
export function traceSystemAttributes(traceId: string): Record<string, MessageAttribute> {
  return { [TRACE_ATTRIBUTE]: { DataType: 'String', StringValue: rootHeader(traceId) } };
}

/** The trace a queue message carries in its AWSTraceHeader, if any. */
export function messageTrace(systemAttributes: Record<string, MessageAttribute> | undefined): string | undefined {
  return traceRoot(systemAttributes?.[TRACE_ATTRIBUTE]?.StringValue);
}

/**
 * A batch's trace, as its call joins it: the first message's that carries one, with that message's ID; else a new
 * one, with the first message's.
 */
export function batchTrace(messages: ReadonlyArray<{ messageId: string; meta: { systemAttributes?: Record<string, MessageAttribute> } }>): {
  traceId: string;
  messageId: string;
} {
  for (const message of messages) {
    const traceId = messageTrace(message.meta.systemAttributes);
    if (traceId) return { traceId, messageId: message.messageId };
  }
  return { traceId: newTraceId(), messageId: messages[0].messageId };
}

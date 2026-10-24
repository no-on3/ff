import { createHash } from 'node:crypto';
import { SqsError, invalidParameter, missingParameter } from './sqs-error';

/** A message attribute as SQS takes one: its type, and a string, or binary in base64, as JSON carries it. */
export interface MessageAttribute {
  DataType: string;
  StringValue?: string;
  BinaryValue?: string;
}

/** SQS's most attributes on one message. */
export const MAX_MESSAGE_ATTRIBUTES = 10;

/**
 * Whether text holds only the characters SQS allows in a message, as XML 1.0
 * does: tab, line feed, carriage return, and from space up, but for lone
 * surrogates, U+FFFE and U+FFFF.
 */
function allowed(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) return false;
  }
  return true;
}

export const md5Hex = (data: string | Buffer): string => createHash('md5').update(data).digest('hex');

/** A message's body, as SQS takes one: text of at least a character, of the characters it allows. */
export function checkBody(body: unknown): string {
  if (body === undefined || body === null) throw missingParameter('MessageBody');
  if (typeof body !== 'string') throw invalidParameter('The message body must be a string.');
  if (body === '') throw invalidParameter('The request must contain a non-empty message body.');
  if (!allowed(body)) {
    throw new SqsError(
      400,
      'InvalidMessageContents',
      'Invalid characters found in the message body: the set of allowed characters is #x9 | #xA | #xD | #x20 to #xD7FF | #xE000 to #xFFFD | #x10000 to #x10FFFF.',
    );
  }
  return body;
}

const isBase64 = (value: string): boolean => /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;

/**
 * A message's attributes, as SQS takes them: ten at most, each name SQS's
 * (letters, digits, "_", "-", "."; no "AWS." or "Amazon." prefix), its type
 * String, Number or Binary with a custom part if any, and its value. Lists of
 * values, which SQS reserves, are refused.
 */
export function checkMessageAttributes(attributes: unknown, field = 'MessageAttributes'): Record<string, MessageAttribute> {
  if (attributes === undefined || attributes === null) return {};
  if (typeof attributes !== 'object' || Array.isArray(attributes)) throw invalidParameter(`${field} must be a map of attribute names to values.`);
  const entries = Object.entries(attributes as Record<string, unknown>);
  if (entries.length > MAX_MESSAGE_ATTRIBUTES) {
    throw invalidParameter(`Number of message attributes [${entries.length}] exceeds the allowed maximum [${MAX_MESSAGE_ATTRIBUTES}].`);
  }
  const checked: Record<string, MessageAttribute> = {};
  for (const [name, value] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,256}$/.test(name) || name.startsWith('.') || name.endsWith('.') || name.includes('..') || /^(aws|amazon)\./i.test(name)) {
      throw invalidParameter(`Message attribute name '${name}' is invalid: letters, digits, '_', '-' and '.' only, 256 at most, no '.' first, last or twice, no AWS. or Amazon. prefix.`);
    }
    const attribute = value as Partial<MessageAttribute> & { StringListValues?: unknown; BinaryListValues?: unknown };
    if (!attribute || typeof attribute !== 'object') throw invalidParameter(`The message attribute '${name}' must be a map.`);
    if (attribute.StringListValues !== undefined || attribute.BinaryListValues !== undefined) {
      throw invalidParameter(`The message attribute '${name}' has a list of values, which SQS reserves and doesn't take.`);
    }
    const type = attribute.DataType;
    if (typeof type !== 'string' || !/^(String|Number|Binary)(\.[!-~]+)?$/.test(type) || type.length > 256) {
      throw invalidParameter(`The type of message attribute '${name}' is invalid: String, Number or Binary, with a custom part if any, 256 characters at most.`);
    }
    if (type.startsWith('Binary')) {
      if (typeof attribute.BinaryValue !== 'string' || !isBase64(attribute.BinaryValue) || attribute.BinaryValue === '') {
        throw invalidParameter(`The message attribute '${name}' with type 'Binary' must use field 'Binary'.`);
      }
      checked[name] = { DataType: type, BinaryValue: attribute.BinaryValue };
    } else {
      if (typeof attribute.StringValue !== 'string' || attribute.StringValue === '') {
        throw invalidParameter(`The message attribute '${name}' must contain a non-empty message attribute value.`);
      }
      if (type.startsWith('Number') && !Number.isFinite(Number(attribute.StringValue))) {
        throw invalidParameter(`Can't cast the value of message (user) attribute '${name}' to a number.`);
      }
      if (!allowed(attribute.StringValue)) throw new SqsError(400, 'InvalidMessageContents', `The value of message attribute '${name}' has characters SQS doesn't allow.`);
      checked[name] = { DataType: type, StringValue: attribute.StringValue };
    }
  }
  return checked;
}

/** The system attributes a message may carry, as SQS takes them: AWSTraceHeader alone, a string. */
export function checkSystemAttributes(attributes: unknown): Record<string, MessageAttribute> {
  const checked = checkMessageAttributes(attributes, 'MessageSystemAttributes');
  for (const [name, attribute] of Object.entries(checked)) {
    if (name !== 'AWSTraceHeader' || attribute.DataType !== 'String') {
      throw invalidParameter(`Message system attribute name '${name}' is invalid: SQS takes AWSTraceHeader, a String.`);
    }
  }
  return checked;
}

/** SQS's MD5 of a message's attributes: each, by name, its name, its type and its value, each length-prefixed, a byte saying which kind of value. */
export function attributesMd5(attributes: Record<string, MessageAttribute>): string | undefined {
  const names = Object.keys(attributes).sort();
  if (names.length === 0) return undefined;
  const parts: Buffer[] = [];
  const lengthPrefixed = (buffer: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(buffer.length);
    parts.push(length, buffer);
  };
  for (const name of names) {
    const { DataType, StringValue, BinaryValue } = attributes[name];
    lengthPrefixed(Buffer.from(name, 'utf8'));
    lengthPrefixed(Buffer.from(DataType, 'utf8'));
    if (BinaryValue !== undefined) {
      parts.push(Buffer.from([2]));
      lengthPrefixed(Buffer.from(BinaryValue, 'base64'));
    } else {
      parts.push(Buffer.from([1]));
      lengthPrefixed(Buffer.from(StringValue ?? '', 'utf8'));
    }
  }
  return md5Hex(Buffer.concat(parts));
}

/** A message's size, as SQS counts it against the queue's maximum: its body and each attribute's name, type and value, in bytes. */
export function messageSize(body: string, attributes: Record<string, MessageAttribute>): number {
  let size = Buffer.byteLength(body, 'utf8');
  for (const [name, { DataType, StringValue, BinaryValue }] of Object.entries(attributes)) {
    size += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(DataType, 'utf8');
    size += BinaryValue !== undefined ? Buffer.from(BinaryValue, 'base64').length : Buffer.byteLength(StringValue ?? '', 'utf8');
  }
  return size;
}

/** What a receipt handle names: the message's row, the receive it was given at, and the message's ID. */
export interface Receipt {
  id: string;
  receiveCount: number;
  messageId: string;
}

/** A receive's receipt handle: each receive of a message gives another, and only the last one's deletes it or changes its visibility. */
export const receiptHandle = (receipt: Receipt): string => Buffer.from(`${receipt.id}:${receipt.receiveCount}:${receipt.messageId}`, 'utf8').toString('base64url');

/** What a receipt handle names; undefined for a string no receive gave. */
export function parseReceiptHandle(handle: unknown): Receipt | undefined {
  if (typeof handle !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(handle)) return undefined;
  const match = /^(\d{1,19}):(\d{1,10}):([0-9a-f-]{36})$/.exec(Buffer.from(handle, 'base64url').toString('utf8'));
  return match ? { id: match[1], receiveCount: Number(match[2]), messageId: match[3] } : undefined;
}

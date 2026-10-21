import { ValidateBy, ValidationArguments } from 'class-validator';

const bytes = (count: number) => count.toLocaleString('en-US');

/** A JSON value's size as the API stores and sends it: its text's bytes in UTF-8. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * A string of at most `limit` bytes in UTF-8, as it is stored and sent: a
 * character outside ASCII counts for two to four. The message says how many
 * the string has, and why the limit is what it is.
 */
export function MaxUtf8Bytes(limit: number, why: string) {
  return ValidateBy({
    name: 'maxUtf8Bytes',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') <= limit,
      defaultMessage: ({ property, value }: ValidationArguments) =>
        `${property} is ${bytes(Buffer.byteLength(String(value), 'utf8'))} bytes of UTF-8; it may have ${bytes(limit)} at most, ${why}`,
    },
  });
}

/** A JSON value whose text has at most `limit` bytes. */
export function MaxJsonBytes(limit: number, why: string) {
  return ValidateBy({
    name: 'maxJsonBytes',
    validator: {
      validate: (value: unknown) => value === undefined || jsonBytes(value) <= limit,
      defaultMessage: ({ property, value }: ValidationArguments) =>
        `${property} is ${bytes(jsonBytes(value))} bytes as JSON; it may have ${bytes(limit)} at most, ${why}`,
    },
  });
}

/**
 * What an invocation's history keeps of its input, output and error (P-45).
 * They hold the personal data of the customer's own users, so the history
 * keeps no more than it needs, and only what PostgreSQL can store. The caller
 * of an invoke still gets them whole.
 */

/** The most the history keeps of each: bytes of UTF-8, of a value's compact JSON text, or of an error's text. */
export const HISTORY_FIELD_BYTES = 64 * 1024;

/** What the history keeps of something, and whether that is only its start. */
export interface Kept<T> {
  value: T;
  truncated: boolean;
}

/**
 * The escapes of JSON.stringify's text that jsonb refuses: \u0000, as text
 * can't hold NUL, and a lone surrogate's, which JSON.stringify escapes (a pair
 * it writes as its character). An escaped backslash matches first, so that a
 * backslash followed by "u0000" stays as it is.
 */
const UNSTORABLE_ESCAPE = /\\(?:\\|u0000|ud[89a-f][0-9a-f]{2})/g;

/** The longest start of `text` whose UTF-8 fits in `bytes`, cut between two characters. */
export function utf8Start(text: string, bytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--; // a continuation byte: its character started before `end`
  return encoded.subarray(0, end).toString('utf8');
}

/**
 * What the history keeps of a JSON value: the value itself, with each
 * character PostgreSQL can't store as U+FFFD; or, when its JSON text is longer
 * than 64 KiB, the start of that text, as a string, marked truncated.
 * `undefined` stays undefined: no value.
 */
export function keptJson(value: unknown): Kept<unknown> {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) return { value, truncated: false };
  const storable = text.replace(UNSTORABLE_ESCAPE, (escape) => (escape === '\\\\' ? escape : '\\ufffd'));
  if (Buffer.byteLength(storable) <= HISTORY_FIELD_BYTES) {
    return { value: storable === text ? value : JSON.parse(storable), truncated: false };
  }
  return { value: utf8Start(storable, HISTORY_FIELD_BYTES), truncated: true };
}

/**
 * What the history keeps of an error's text: NUL, which PostgreSQL's text
 * can't hold, as U+FFFD; at most 64 KiB of it, marked truncated when cut.
 * (A lone surrogate becomes U+FFFD on its way to the database.)
 */
export function keptText(text: string): Kept<string> {
  const storable = text.replaceAll('\u0000', '\ufffd');
  if (Buffer.byteLength(storable) <= HISTORY_FIELD_BYTES) return { value: storable, truncated: false };
  return { value: utf8Start(storable, HISTORY_FIELD_BYTES), truncated: true };
}

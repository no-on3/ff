/**
 * What a function's return value answers its URL's caller, by AWS Lambda's
 * rules for function URLs (API Gateway's payload format 2.0):
 * - an object with a statusCode is a response: statusCode, headers, cookies, body, isBase64Encoded;
 * - anything else answers 200 with content-type application/json and the value as JSON, a string in quotes.
 */

export interface UrlAnswer {
  status: number;
  /** Name and value pairs, Set-Cookie repeated. */
  headers: Array<[string, string]>;
  body: Buffer;
}

/** A return value that can't be an HTTP response: the caller gets 502, and the reason goes to the backend's log. */
export class InvalidUrlResponseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidUrlResponseError';
  }
}

/** An HTTP token, as a header's name must be (RFC 9110, §5.6.2). */
export const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What a header's value may not hold: a line break or NUL would split or end it. */
const UNSAFE_VALUE = /[\r\n\0]/;
/** Headers the server sets itself, per connection or from the body: never the function's. */
const SERVER_HEADERS = new Set(['connection', 'content-length', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A final answer's status: 1xx are interim answers, which HTTP never ends a request with. */
function statusOf(value: unknown): number {
  const status = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new InvalidUrlResponseError(`statusCode must be a whole number from 200 to 599; got ${JSON.stringify(value)}`);
  }
  return status;
}

function headerValue(name: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new InvalidUrlResponseError(`the header ${name}'s value must be a string, a number or a boolean`);
  }
  const text = String(value);
  if (UNSAFE_VALUE.test(text)) throw new InvalidUrlResponseError(`the header ${name}'s value holds a line break or NUL`);
  return text;
}

function bodyOf(response: Record<string, unknown>): Buffer {
  const { body, isBase64Encoded } = response;
  if (body === undefined || body === null) return Buffer.alloc(0);
  // A body that isn't text is sent as its JSON, as LocalStack does; AWS's own answer to it isn't documented.
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return isBase64Encoded === true ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
}

/** The HTTP answer for a function's return value. Throws InvalidUrlResponseError for a response that can't be sent. */
export function urlAnswer(output: unknown): UrlAnswer {
  if (!isObject(output) || !('statusCode' in output)) {
    return { status: 200, headers: [['content-type', 'application/json']], body: Buffer.from(JSON.stringify(output ?? null), 'utf8') };
  }
  const status = statusOf(output.statusCode);
  const headers: Array<[string, string]> = [];
  if (output.headers !== undefined && output.headers !== null) {
    if (!isObject(output.headers)) throw new InvalidUrlResponseError('headers must be an object of names to values');
    for (const [name, raw] of Object.entries(output.headers)) {
      if (!TOKEN.test(name)) throw new InvalidUrlResponseError(`${JSON.stringify(name)} is not a header name`);
      const value = headerValue(name, raw);
      if (value !== undefined && !SERVER_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
    }
  }
  if (output.cookies !== undefined && output.cookies !== null) {
    if (!Array.isArray(output.cookies) || output.cookies.some((cookie) => typeof cookie !== 'string')) {
      throw new InvalidUrlResponseError('cookies must be a list of strings');
    }
    for (const cookie of output.cookies as string[]) {
      if (UNSAFE_VALUE.test(cookie)) throw new InvalidUrlResponseError('a cookie holds a line break or NUL');
      headers.push(['set-cookie', cookie]);
    }
  }
  // Without a type of its own, the answer says JSON, as Lambda's does.
  if (!headers.some(([name]) => name.toLowerCase() === 'content-type')) headers.push(['content-type', 'application/json']);
  return { status, headers, body: bodyOf(output) };
}

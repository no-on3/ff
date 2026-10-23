import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { S3Error, accessDenied, invalidRequest, malformedAuthorization, malformedQueryAuthorization, signatureMismatch } from './s3-error';

/** AWS Signature Version 4's only algorithm. */
export const ALGORITHM = 'AWS4-HMAC-SHA256';

/** The payload of a request that doesn't sign its body, as presigned URLs never do. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** How far a header-signed request's time may be from the front door's, as S3 allows. */
export const MAX_CLOCK_SKEW_MS = 15 * 60_000;

/** A presigned URL lives from 1 second to 7 days. */
export const MAX_PRESIGNED_SECONDS = 604_800;

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** The SHA-256 of nothing: an empty body's, and every aws-chunked chunk's string to sign has it. */
export const EMPTY_SHA256 = sha256Hex('');

/** The key a day's signatures are made with, for a region and a service: derived from the secret, never the secret itself. */
export function signingKey(secret: string, date: string, region: string, service = 's3'): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** RFC 3986's encoding, as Signature Version 4 wants it: every byte but the unreserved ones, upper-case hex; "/" kept in a path if asked. */
export function uriEncode(text: string, keepSlash = false): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += UNRESERVED.test(char) || (keepSlash && char === '/') ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** %XX escapes decoded, and nothing else: "+" stays "+", as Signature Version 4 reads a query. Text that isn't valid stays as it is. */
export function decodeEscapes(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The path as S3 signs it: each segment encoded once, each escape as the client meant it, nothing normalized: "a//b" stays. */
export function canonicalUri(rawPath: string): string {
  return rawPath.split('/').map((segment) => uriEncode(decodeEscapes(segment))).join('/') || '/';
}

/** The query as Signature Version 4 signs it: each name and value encoded, sorted by name then value; `exclude` left out. */
export function canonicalQuery(rawQuery: string, exclude?: string): string {
  if (!rawQuery) return '';
  return rawQuery
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const name = decodeEscapes(at < 0 ? pair : pair.slice(0, at));
      const value = decodeEscapes(at < 0 ? '' : pair.slice(at + 1));
      return { name, encoded: [uriEncode(name), uriEncode(value)] as const };
    })
    .filter(({ name }) => name !== exclude)
    .map(({ encoded }) => encoded)
    .sort(([nameA, valueA], [nameB, valueB]) => (nameA === nameB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : nameA < nameB ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** A header's values as Signature Version 4 joins them: each trimmed, inner spaces collapsed, joined by ","; undefined when absent. */
export function canonicalHeaderValue(rawHeaders: string[], name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) values.push(rawHeaders[i + 1].trim().replace(/\s+/g, ' '));
  }
  return values.length ? values.join(',') : undefined;
}

/** What a request's signature says, from its Authorization header or, presigned, from its query. */
export interface RequestSignature {
  kind: 'header' | 'presigned';
  accessKeyId: string;
  /** The scope's day, YYYYMMDD. */
  date: string;
  /** The scope's region: any signs, as the key is the secret, not the region. */
  region: string;
  signedHeaders: string[];
  signature: string;
  /** The request's time as signed, YYYYMMDDTHHMMSSZ. */
  amzDate: string;
  /** The body as signed: its SHA-256 in hex, UNSIGNED-PAYLOAD, or one of aws-chunked's forms. */
  payload: string;
  /** A presigned URL's life, in seconds. */
  expires?: number;
}

/** What a signature is checked against: the request as it came, its path and query unparsed, its headers as sent. */
export interface SignedRequest {
  method: string;
  rawPath: string;
  rawQuery: string;
  rawHeaders: string[];
}

/** What an aws-chunked body's chunk signatures chain from: the day's key, the scope, the time, and the request's own signature. */
export interface SigningChain {
  key: Buffer;
  scope: string;
  amzDate: string;
  seed: string;
}

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const QUERY_PARAMETERS = ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Signature', 'X-Amz-Date', 'X-Amz-SignedHeaders', 'X-Amz-Expires'];

/** The parts of a credential's scope: <access key ID>/<day>/<region>/s3/aws4_request. */
function credentialOf(credential: string, malformed: (detail: string) => S3Error): { accessKeyId: string; date: string; region: string } {
  const parts = credential.split('/');
  if (parts.length !== 5 || !parts[0] || !parts[2]) throw malformed('the Credential is not <key>/<date>/<region>/s3/aws4_request');
  const [accessKeyId, date, region, service, terminator] = parts;
  if (!/^\d{8}$/.test(date)) throw malformed(`incorrect date "${date}"`);
  if (service !== 's3') throw malformed(`incorrect service "${service}". This endpoint belongs to "s3".`);
  if (terminator !== 'aws4_request') throw malformed(`incorrect terminal "${terminator}". This endpoint uses "aws4_request".`);
  return { accessKeyId, date, region };
}

/**
 * A request's signature, read but not yet checked; null for an anonymous
 * request. FF's keys have no session token: a request that carries one is
 * refused, as a token FF never issued.
 */
export function readSignature(headers: IncomingHttpHeaders, query: URLSearchParams): RequestSignature | null {
  const header = single(headers.authorization);
  const presigned = query.has('X-Amz-Algorithm') || query.has('X-Amz-Signature') || query.has('X-Amz-Credential');
  if (header !== undefined && presigned) throw new S3Error(400, 'InvalidArgument', 'Only one auth mechanism allowed; only the X-Amz-Algorithm query parameter or the Authorization header should be specified');
  if (headers['x-amz-security-token'] !== undefined || query.has('X-Amz-Security-Token')) {
    throw new S3Error(400, 'InvalidToken', 'The provided token is malformed or otherwise invalid.');
  }
  if (header !== undefined) {
    if (!header.startsWith(`${ALGORITHM} `)) throw invalidRequest('The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.');
    const fields = new Map<string, string>();
    for (const part of header.slice(ALGORITHM.length + 1).split(',')) {
      const at = part.indexOf('=');
      if (at > 0) fields.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
    const credential = fields.get('Credential');
    const signedHeaders = fields.get('SignedHeaders');
    const signature = fields.get('Signature');
    if (!credential || !signedHeaders || !signature) throw malformedAuthorization('it needs a Credential, SignedHeaders and a Signature');
    const amzDate = single(headers['x-amz-date']);
    if (!amzDate) throw malformedAuthorization('the request has no x-amz-date header');
    const payload = single(headers['x-amz-content-sha256']);
    if (!payload) throw invalidRequest('Missing required header for this request: x-amz-content-sha256');
    return { kind: 'header', ...credentialOf(credential, malformedAuthorization), signedHeaders: signedHeaders.split(';'), signature, amzDate, payload };
  }
  if (!presigned) return null;
  if (query.get('X-Amz-Algorithm') !== ALGORITHM) throw malformedQueryAuthorization('X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"');
  if (QUERY_PARAMETERS.some((name) => !query.get(name))) {
    throw malformedQueryAuthorization(
      'Query-string authentication version 4 requires the X-Amz-Algorithm, X-Amz-Credential, X-Amz-Signature, X-Amz-Date, X-Amz-SignedHeaders, and X-Amz-Expires parameters.',
    );
  }
  const expires = Number(query.get('X-Amz-Expires'));
  if (!Number.isInteger(expires) || expires < 1) throw malformedQueryAuthorization('X-Amz-Expires must be a whole number of seconds, 1 at least');
  if (expires > MAX_PRESIGNED_SECONDS) throw malformedQueryAuthorization('X-Amz-Expires must be less than a week (in seconds) that is 604800');
  return {
    kind: 'presigned',
    ...credentialOf(query.get('X-Amz-Credential') as string, (detail) => malformedQueryAuthorization(`Error parsing the X-Amz-Credential parameter; ${detail}`)),
    signedHeaders: (query.get('X-Amz-SignedHeaders') as string).split(';'),
    signature: query.get('X-Amz-Signature') as string,
    amzDate: query.get('X-Amz-Date') as string,
    payload: query.get('X-Amz-Content-Sha256') ?? UNSIGNED_PAYLOAD,
    expires,
  };
}

/** A signed time, YYYYMMDDTHHMMSSZ, in milliseconds since the epoch; NaN when malformed. */
export function signedTime(amzDate: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : Number.NaN;
}

/** The canonical request's hash and its string to sign, for one form of the path. */
function stringToSign(request: SignedRequest, signature: RequestSignature, path: string, scope: string): string {
  const headers = signature.signedHeaders.map((name) => `${name}:${canonicalHeaderValue(request.rawHeaders, name) ?? ''}\n`).join('');
  const query = canonicalQuery(request.rawQuery, signature.kind === 'presigned' ? 'X-Amz-Signature' : undefined);
  const canonical = [request.method, path, query, headers, signature.signedHeaders.join(';'), signature.payload].join('\n');
  return [ALGORITHM, signature.amzDate, scope, sha256Hex(canonical)].join('\n');
}

const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a signature with the key's secret, as S3 does: its time (within 15
 * minutes of now in a header; a presigned URL until it expires), the signed
 * headers (host, and for a header the body's hash), then the signature itself.
 * The path is tried as S3 signs it, then as the client sent it, which some
 * clients sign. Answers what an aws-chunked body's chunks chain from.
 */
export function checkSignature(request: SignedRequest, signature: RequestSignature, secret: string, now: Date): SigningChain {
  const malformed = signature.kind === 'header' ? malformedAuthorization : malformedQueryAuthorization;
  const signedAt = signedTime(signature.amzDate);
  if (Number.isNaN(signedAt)) throw malformed(`the date "${signature.amzDate}" is not YYYYMMDDTHHMMSSZ`);
  if (!signature.amzDate.startsWith(signature.date)) throw malformed(`the credential's date "${signature.date}" is not the request's`);
  if (signature.kind === 'header' && Math.abs(now.getTime() - signedAt) > MAX_CLOCK_SKEW_MS) {
    throw new S3Error(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.');
  }
  if (signature.kind === 'presigned') {
    if (signedAt - now.getTime() > MAX_CLOCK_SKEW_MS) throw accessDenied('Request is not valid yet');
    if (now.getTime() > signedAt + (signature.expires as number) * 1000) throw accessDenied('Request has expired');
  }
  if (!signature.signedHeaders.includes('host')) throw malformed('the host header must be signed');
  if (signature.kind === 'header' && !signature.signedHeaders.includes('x-amz-content-sha256')) throw malformed('the x-amz-content-sha256 header must be signed');
  const scope = `${signature.date}/${signature.region}/s3/aws4_request`;
  const key = signingKey(secret, signature.date, signature.region);
  for (const path of new Set([canonicalUri(request.rawPath), request.rawPath || '/'])) {
    if (sameHex(hmac(key, stringToSign(request, signature, path, scope)).toString('hex'), signature.signature)) {
      return { key, scope, amzDate: signature.amzDate, seed: signature.signature };
    }
  }
  throw signatureMismatch();
}

/**
 * The headers that sign a request of FF's own to the store, with FF's
 * credentials there: every header given signed, the body unsigned, as S3
 * allows over HTTPS and S3-compatible stores over HTTP.
 */
export function signedForStore(
  request: { method: string; host: string; rawPath: string; rawQuery: string; headers: Record<string, string> },
  credentials: { accessKeyId: string; secretAccessKey: string; region: string },
  now: Date,
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  Object.assign(headers, { host: request.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': UNSIGNED_PAYLOAD });
  const names = Object.keys(headers).sort();
  const canonical = [
    request.method,
    canonicalUri(request.rawPath),
    canonicalQuery(request.rawQuery),
    names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const scope = `${date}/${credentials.region}/s3/aws4_request`;
  const signature = hmac(signingKey(credentials.secretAccessKey, date, credentials.region), [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n')).toString('hex');
  return { ...headers, authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

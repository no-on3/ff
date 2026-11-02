import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';

/**
 * AWS Signature Version 4, read and checked once for every front door AWS's
 * tools sign for. Each front door says three things (SignedService): its
 * service's name in a credential's scope, how it signs a path, and the words
 * it refuses a signature with. S3's presigned URLs and streaming chunks stay
 * S3's own, on top of this.
 */

/** Signature Version 4's only algorithm. */
export const ALGORITHM = 'AWS4-HMAC-SHA256';

/** How far a header-signed request's time may be from the front door's, as AWS allows. */
export const MAX_CLOCK_SKEW_MS = 15 * 60_000;

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

export const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** The SHA-256 of nothing: an empty body's, and every aws-chunked chunk's string to sign has it. */
export const EMPTY_SHA256 = sha256Hex('');

/** The key a day's signatures are made with, for a region and a service: derived from the secret, never the secret itself. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** A credential's scope: the day, the region and the service a signature is for. */
export const scopeOf = (date: string, region: string, service: string): string => `${date}/${region}/${service}/aws4_request`;

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

/**
 * The path as AWS signs it for every service but S3 (ADR 0012): each segment
 * escaped twice, so that an address's "@", %40 on the wire, is %2540 in what
 * is signed; a segment sent unescaped is escaped as the client meant it.
 */
export function canonicalUriTwice(rawPath: string): string {
  return rawPath.split('/').map((segment) => uriEncode(uriEncode(decodeEscapes(segment)))).join('/') || '/';
}

/**
 * A path as AWS normalizes it for every service but S3, before signing it:
 * empty and "." segments gone, each ".." taking the segment before with it;
 * a trailing "/" kept, as AWS's signers keep it.
 */
export function normalizedPath(rawPath: string): string {
  const segments: string[] = [];
  for (const segment of rawPath.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '' && segment !== '.') segments.push(segment);
  }
  return `/${segments.join('/')}${segments.length > 0 && rawPath.endsWith('/') ? '/' : ''}`;
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

/** What a signature is checked against: the request as it came, its path and query unparsed, its headers as sent. */
export interface SignedRequest {
  method: string;
  rawPath: string;
  rawQuery: string;
  rawHeaders: string[];
}

/**
 * The canonical request Signature Version 4 hashes: the method, the path in
 * the service's form, the query (a presigned URL's signature left out), each
 * signed header with its value, their names, and the body as signed.
 */
export function canonicalRequest(request: SignedRequest, path: string, signedHeaders: string[], payload: string, unsignedQuery?: string): string {
  const headers = signedHeaders.map((name) => `${name}:${canonicalHeaderValue(request.rawHeaders, name) ?? ''}\n`).join('');
  return [request.method, path, canonicalQuery(request.rawQuery, unsignedQuery), headers, signedHeaders.join(';'), payload].join('\n');
}

/** What is signed: the algorithm, the time, the scope and the canonical request's hash. */
export const stringToSign = (amzDate: string, scope: string, canonical: string): string => [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');

/** What can be wrong with a signature, which each front door says in its service's words. */
export type SignatureProblem =
  /** A session token: FF's keys have none, so it is one FF never issued. */
  | { kind: 'token' }
  /** An Authorization header that isn't AWS4-HMAC-SHA256's. */
  | { kind: 'algorithm' }
  /** No Credential, SignedHeaders or Signature. */
  | { kind: 'parts' }
  /** A credential that isn't <access key ID>/<day>/<region>/<service>/aws4_request: its shape, its day or its last part. */
  | { kind: 'credential'; part: 'shape' | 'date' | 'terminal'; value: string }
  /** A credential scoped to another service. */
  | { kind: 'service'; named: string }
  /** No X-Amz-Date. */
  | { kind: 'no-date' }
  /** A time that isn't YYYYMMDDTHHMMSSZ. */
  | { kind: 'date'; amzDate: string }
  /** A time on another day than the credential's. */
  | { kind: 'other-day'; date: string; amzDate: string }
  /** A time more than 15 minutes from now, either way. */
  | { kind: 'skewed'; amzDate: string }
  /** A header that must be signed and isn't. */
  | { kind: 'unsigned'; header: string }
  /** A signature that isn't the key's. */
  | { kind: 'mismatch' };

/** What a front door tells the check. */
export interface SignedService {
  /** Its name in a credential's scope: s3, sqs, ses, lambda. */
  name: string;
  /**
   * How it signs a path: S3's way ('once': each segment encoded once, nothing
   * normalized), or every other service's ('twice': normalized, each segment
   * escaped twice, so that an ARN's colon, %3A on the wire, is signed %253A).
   */
  paths: 'once' | 'twice';
  /** Its error for a problem, in its words. */
  refuse(problem: SignatureProblem): Error;
}

/** What an Authorization header's signature says, read but not yet checked. */
export interface HeaderSignature {
  accessKeyId: string;
  /** The scope's day, YYYYMMDD. */
  date: string;
  /** The scope's region: any signs, as the key is the secret, not the region. */
  region: string;
  signedHeaders: string[];
  signature: string;
  /** The request's time as signed, YYYYMMDDTHHMMSSZ. */
  amzDate: string;
}

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** A credential's parts: <access key ID>/<day>/<region>/<service>/aws4_request, scoped to the service. */
export function readCredential(credential: string, service: SignedService): Pick<HeaderSignature, 'accessKeyId' | 'date' | 'region'> {
  const parts = credential.split('/');
  if (parts.length !== 5 || !parts[0] || !parts[2]) throw service.refuse({ kind: 'credential', part: 'shape', value: credential });
  const [accessKeyId, date, region, named, terminator] = parts;
  if (!/^\d{8}$/.test(date)) throw service.refuse({ kind: 'credential', part: 'date', value: date });
  if (named !== service.name) throw service.refuse({ kind: 'service', named });
  if (terminator !== 'aws4_request') throw service.refuse({ kind: 'credential', part: 'terminal', value: terminator });
  return { accessKeyId, date, region };
}

/**
 * A request's signature, from its Authorization header; null when it has
 * none. FF's keys have no session token: a request that carries one is
 * refused, as a token FF never issued.
 */
export function readAuthorization(headers: IncomingHttpHeaders, service: SignedService): HeaderSignature | null {
  const header = single(headers.authorization);
  if (header === undefined) return null;
  if (headers['x-amz-security-token'] !== undefined) throw service.refuse({ kind: 'token' });
  if (!header.startsWith(`${ALGORITHM} `)) throw service.refuse({ kind: 'algorithm' });
  const fields = new Map<string, string>();
  for (const part of header.slice(ALGORITHM.length + 1).split(',')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const credential = fields.get('Credential');
  const signedHeaders = fields.get('SignedHeaders');
  const signature = fields.get('Signature');
  if (!credential || !signedHeaders || !signature) throw service.refuse({ kind: 'parts' });
  const scope = readCredential(credential, service);
  const amzDate = single(headers['x-amz-date']);
  if (!amzDate) throw service.refuse({ kind: 'no-date' });
  return { ...scope, signedHeaders: signedHeaders.split(';'), signature, amzDate };
}

/** A signed time, YYYYMMDDTHHMMSSZ, in milliseconds since the epoch; NaN when malformed. */
export function signedTime(amzDate: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : Number.NaN;
}

/** The time a request was signed at, in milliseconds: well formed, and on the credential's day. */
export function signedAt(signature: Pick<HeaderSignature, 'date' | 'amzDate'>, service: SignedService): number {
  const at = signedTime(signature.amzDate);
  if (Number.isNaN(at)) throw service.refuse({ kind: 'date', amzDate: signature.amzDate });
  if (!signature.amzDate.startsWith(signature.date)) throw service.refuse({ kind: 'other-day', date: signature.date, amzDate: signature.amzDate });
  return at;
}

/** A header-signed request's time, within 15 minutes of now, either way. */
export function checkSkew(at: number, amzDate: string, now: Date, service: SignedService): void {
  if (Math.abs(now.getTime() - at) > MAX_CLOCK_SKEW_MS) throw service.refuse({ kind: 'skewed', amzDate });
}

/** A header the service needs signed, among those signed. */
export function requireSigned(signedHeaders: string[], header: string, service: SignedService): void {
  if (!signedHeaders.includes(header)) throw service.refuse({ kind: 'unsigned', header });
}

/** What an aws-chunked body's chunk signatures chain from: the day's key, the scope, the time, and the request's own signature. */
export interface SigningChain {
  key: Buffer;
  scope: string;
  amzDate: string;
  seed: string;
}

/**
 * The path in a service's form, as AWS's signers make it: S3's, each segment
 * encoded once; every other service's, the path as sent normalized and
 * escaped once more, so that %3A on the wire is %253A.
 */
export function canonicalPath(rawPath: string, paths: SignedService['paths']): string {
  return paths === 'once' ? canonicalUri(rawPath) : uriEncode(normalizedPath(rawPath), true);
}

/**
 * The forms of a path the service may have signed, tried in turn: its own,
 * then, for S3, the path as sent, which some clients sign; for every other
 * service, each segment escaped twice as the client meant it, for one that
 * sent it unescaped.
 */
const pathForms = (rawPath: string, paths: SignedService['paths']): Set<string> =>
  new Set([canonicalPath(rawPath, paths), paths === 'once' ? rawPath || '/' : canonicalUriTwice(rawPath)]);

const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The signature checked against the key's secret, over the request and its
 * body as signed (`payload`: its SHA-256 in hex, or S3's UNSIGNED-PAYLOAD and
 * aws-chunked forms). Answers what an aws-chunked body's chunks chain from.
 */
export function matchSignature(
  request: SignedRequest,
  signature: Omit<HeaderSignature, 'accessKeyId'>,
  payload: string,
  secret: string,
  service: SignedService,
  unsignedQuery?: string,
): SigningChain {
  const scope = scopeOf(signature.date, signature.region, service.name);
  const key = signingKey(secret, signature.date, signature.region, service.name);
  for (const path of pathForms(request.rawPath, service.paths)) {
    const canonical = canonicalRequest(request, path, signature.signedHeaders, payload, unsignedQuery);
    if (sameHex(hmac(key, stringToSign(signature.amzDate, scope, canonical)).toString('hex'), signature.signature)) {
      return { key, scope, amzDate: signature.amzDate, seed: signature.signature };
    }
  }
  throw service.refuse({ kind: 'mismatch' });
}

/**
 * Checks an Authorization header's signature with the key's secret, as AWS's
 * services but S3 do: the time, within 15 minutes of now; the host signed;
 * then the signature over the request and the SHA-256 of its body.
 */
export function checkAuthorization(request: SignedRequest, body: Buffer, signature: HeaderSignature, secret: string, now: Date, service: SignedService): void {
  checkSkew(signedAt(signature, service), signature.amzDate, now, service);
  requireSigned(signature.signedHeaders, 'host', service);
  matchSignature(request, signature, sha256Hex(body), secret, service);
}

/** The errors a service but S3 refuses a signature with: one for what is missing or malformed, one for the rest, and its own for a token. */
export interface ServiceErrors {
  incomplete(message: string): Error;
  mismatch(message?: string): Error;
  token(): Error;
}

/**
 * The words AWS's services but S3 refuse a signature with, SQS's and SES's
 * alike: IncompleteSignature for what is missing or malformed,
 * SignatureDoesNotMatch for another service, an old time, the host unsigned
 * or another signature, and the service's own error for a session token.
 */
export function serviceWords(service: string, errors: ServiceErrors): SignedService['refuse'] {
  return (problem) => {
    switch (problem.kind) {
      case 'token':
        return errors.token();
      case 'algorithm':
        return errors.incomplete('The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.');
      case 'parts':
        return errors.incomplete('Authorization header requires Credential, SignedHeaders and Signature parameters.');
      case 'credential':
        return errors.incomplete(`The Credential is not <access key ID>/<date>/<region>/${service}/aws4_request.`);
      case 'service':
        return errors.mismatch(`Credential should be scoped to correct service: '${service}'.`);
      case 'no-date':
        return errors.incomplete('Authorization header requires existence of either a X-Amz-Date or a Date header.');
      case 'date':
      case 'other-day':
        return errors.incomplete(`The date "${problem.amzDate}" is not YYYYMMDDTHHMMSSZ, or not the credential's.`);
      case 'skewed':
        return errors.mismatch(`Signature expired: ${problem.amzDate} is more than 15 minutes from the request's arrival.`);
      case 'unsigned':
        return errors.mismatch("'Host' must be a 'SignedHeader' in the AWS Authorization.");
      case 'mismatch':
        return errors.mismatch();
    }
  };
}

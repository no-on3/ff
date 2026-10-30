import { timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import { ALGORITHM, MAX_CLOCK_SKEW_MS, SignedRequest, canonicalHeaderValue, canonicalQuery, decodeEscapes, hmac, sha256Hex, signedTime, signingKey, uriEncode } from '../storage/sigv4';
import { incompleteSignature, signatureDoesNotMatch, unrecognizedClient } from './ses-error';

/** A request's signature, as its Authorization header gives it, read but not yet checked. */
export interface SesSignature {
  accessKeyId: string;
  /** The scope's day, YYYYMMDD. */
  date: string;
  region: string;
  signedHeaders: string[];
  signature: string;
  /** The request's time as signed, YYYYMMDDTHHMMSSZ. */
  amzDate: string;
}

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * A request's signature, from its Authorization header, as AWS's SDKs and CLI
 * sign SES v2's requests; null when it has none. FF's keys have no session
 * token: a request that carries one is refused, as a token FF never issued.
 */
export function readSesSignature(headers: IncomingHttpHeaders): SesSignature | null {
  const header = single(headers.authorization);
  if (header === undefined) return null;
  if (headers['x-amz-security-token'] !== undefined) throw unrecognizedClient();
  if (!header.startsWith(`${ALGORITHM} `)) throw incompleteSignature('The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.');
  const fields = new Map<string, string>();
  for (const part of header.slice(ALGORITHM.length + 1).split(',')) {
    const at = part.indexOf('=');
    if (at > 0) fields.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const credential = fields.get('Credential');
  const signedHeaders = fields.get('SignedHeaders');
  const signature = fields.get('Signature');
  if (!credential || !signedHeaders || !signature) throw incompleteSignature('Authorization header requires Credential, SignedHeaders and Signature parameters.');
  const parts = credential.split('/');
  if (parts.length !== 5 || !parts[0] || !/^\d{8}$/.test(parts[1]) || !parts[2] || parts[4] !== 'aws4_request') {
    throw incompleteSignature('The Credential is not <access key ID>/<date>/<region>/ses/aws4_request.');
  }
  if (parts[3] !== 'ses') throw signatureDoesNotMatch(`Credential should be scoped to correct service: 'ses'.`);
  const amzDate = single(headers['x-amz-date']);
  if (!amzDate) throw incompleteSignature('Authorization header requires existence of either a X-Amz-Date or a Date header.');
  return { accessKeyId: parts[0], date: parts[1], region: parts[2], signedHeaders: signedHeaders.split(';'), signature, amzDate };
}

/**
 * The path as AWS signs it for every service but S3 (ADR 0012): each segment
 * escaped twice, so that an address's "@", %40 on the wire, is %2540 in what
 * is signed; a segment sent unescaped is escaped as the client meant it.
 */
export function canonicalUriTwice(rawPath: string): string {
  return rawPath.split('/').map((segment) => uriEncode(uriEncode(decodeEscapes(segment)))).join('/') || '/';
}

const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a signature with the key's secret, as SES does: the time, within 15
 * minutes of now; the host signed; then the signature over the request, its
 * path escaped twice, and the SHA-256 of its body.
 */
export function checkSesSignature(request: SignedRequest, body: Buffer, signature: SesSignature, secret: string, now: Date): void {
  const signedAt = signedTime(signature.amzDate);
  if (Number.isNaN(signedAt) || !signature.amzDate.startsWith(signature.date)) throw incompleteSignature(`The date "${signature.amzDate}" is not YYYYMMDDTHHMMSSZ, or not the credential's.`);
  if (Math.abs(now.getTime() - signedAt) > MAX_CLOCK_SKEW_MS) {
    throw signatureDoesNotMatch(`Signature expired: ${signature.amzDate} is more than 15 minutes from the request's arrival.`);
  }
  if (!signature.signedHeaders.includes('host')) throw signatureDoesNotMatch("'Host' must be a 'SignedHeader' in the AWS Authorization.");
  const headers = signature.signedHeaders.map((name) => `${name}:${canonicalHeaderValue(request.rawHeaders, name) ?? ''}\n`).join('');
  const canonical = [request.method, canonicalUriTwice(request.rawPath), canonicalQuery(request.rawQuery), headers, signature.signedHeaders.join(';'), sha256Hex(body)].join('\n');
  const scope = `${signature.date}/${signature.region}/ses/aws4_request`;
  const expected = hmac(signingKey(secret, signature.date, signature.region, 'ses'), [ALGORITHM, signature.amzDate, scope, sha256Hex(canonical)].join('\n')).toString('hex');
  if (!sameHex(expected, signature.signature)) throw signatureDoesNotMatch();
}

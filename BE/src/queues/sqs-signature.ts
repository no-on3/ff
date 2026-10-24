import { timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';
import {
  ALGORITHM,
  MAX_CLOCK_SKEW_MS,
  SignedRequest,
  canonicalHeaderValue,
  canonicalQuery,
  canonicalUri,
  hmac,
  sha256Hex,
  signedTime,
  signingKey,
} from '../storage/sigv4';
import { incompleteSignature, invalidClientTokenId, signatureDoesNotMatch } from './sqs-error';

/** A request's signature, as its Authorization header gives it, read but not yet checked. */
export interface SqsSignature {
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
 * sign SQS's JSON requests; null when it has none. FF's keys have no session
 * token: a request that carries one is refused, as a token FF never issued.
 */
export function readSqsSignature(headers: IncomingHttpHeaders): SqsSignature | null {
  const header = single(headers.authorization);
  if (header === undefined) return null;
  if (headers['x-amz-security-token'] !== undefined) throw invalidClientTokenId();
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
    throw incompleteSignature('The Credential is not <access key ID>/<date>/<region>/sqs/aws4_request.');
  }
  if (parts[3] !== 'sqs') throw signatureDoesNotMatch(`Credential should be scoped to correct service: 'sqs'.`);
  const amzDate = single(headers['x-amz-date']);
  if (!amzDate) throw incompleteSignature('Authorization header requires existence of either a X-Amz-Date or a Date header.');
  return { accessKeyId: parts[0], date: parts[1], region: parts[2], signedHeaders: signedHeaders.split(';'), signature, amzDate };
}

const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a signature with the key's secret, as SQS does: the time, within 15
 * minutes of now; the host signed; then the signature over the request and
 * the SHA-256 of its body, which SQS's clients sign without sending it.
 */
export function checkSqsSignature(request: SignedRequest, body: Buffer, signature: SqsSignature, secret: string, now: Date): void {
  const signedAt = signedTime(signature.amzDate);
  if (Number.isNaN(signedAt) || !signature.amzDate.startsWith(signature.date)) throw incompleteSignature(`The date "${signature.amzDate}" is not YYYYMMDDTHHMMSSZ, or not the credential's.`);
  if (Math.abs(now.getTime() - signedAt) > MAX_CLOCK_SKEW_MS) {
    throw signatureDoesNotMatch(`Signature expired: ${signature.amzDate} is more than 15 minutes from the request's arrival.`);
  }
  if (!signature.signedHeaders.includes('host')) throw signatureDoesNotMatch("'Host' must be a 'SignedHeader' in the AWS Authorization.");
  const headers = signature.signedHeaders.map((name) => `${name}:${canonicalHeaderValue(request.rawHeaders, name) ?? ''}\n`).join('');
  const canonical = [request.method, canonicalUri(request.rawPath), canonicalQuery(request.rawQuery), headers, signature.signedHeaders.join(';'), sha256Hex(body)].join('\n');
  const scope = `${signature.date}/${signature.region}/sqs/aws4_request`;
  const expected = hmac(signingKey(secret, signature.date, signature.region, 'sqs'), [ALGORITHM, signature.amzDate, scope, sha256Hex(canonical)].join('\n')).toString('hex');
  if (!sameHex(expected, signature.signature)) throw signatureDoesNotMatch();
}

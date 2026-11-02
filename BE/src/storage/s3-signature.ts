import { IncomingHttpHeaders } from 'node:http';
import { single } from '../common/http-request';
import {
  ALGORITHM,
  HeaderSignature,
  MAX_CLOCK_SKEW_MS,
  SignatureProblem,
  SignedRequest,
  SignedService,
  SigningChain,
  canonicalRequest,
  canonicalUri,
  checkSkew,
  hmac,
  matchSignature,
  readAuthorization,
  readCredential,
  requireSigned,
  scopeOf,
  signedAt,
  signingKey,
  stringToSign,
} from '../common/signature-v4';
import { S3Error, accessDenied, invalidRequest, malformedAuthorization, malformedQueryAuthorization, signatureMismatch } from './s3-error';

/** The payload of a request that doesn't sign its body, as presigned URLs never do. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** A presigned URL lives from 1 second to 7 days. */
export const MAX_PRESIGNED_SECONDS = 604_800;

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

/**
 * S3's words for a signature's problems: `malformed` says what is wrong with
 * the header or the query, `credential` what is wrong with its credential.
 */
function s3Words(malformed: (detail: string) => S3Error, credential: (detail: string) => S3Error): SignedService['refuse'] {
  return (problem: SignatureProblem) => {
    switch (problem.kind) {
      case 'token':
        return new S3Error(400, 'InvalidToken', 'The provided token is malformed or otherwise invalid.');
      case 'algorithm':
        return invalidRequest('The authorization mechanism you have provided is not supported. Please use AWS4-HMAC-SHA256.');
      case 'parts':
        return malformed('it needs a Credential, SignedHeaders and a Signature');
      case 'credential':
        if (problem.part === 'date') return credential(`incorrect date "${problem.value}"`);
        if (problem.part === 'terminal') return credential(`incorrect terminal "${problem.value}". This endpoint uses "aws4_request".`);
        return credential('the Credential is not <key>/<date>/<region>/s3/aws4_request');
      case 'service':
        return credential(`incorrect service "${problem.named}". This endpoint belongs to "s3".`);
      case 'no-date':
        return malformed('the request has no x-amz-date header');
      case 'date':
        return malformed(`the date "${problem.amzDate}" is not YYYYMMDDTHHMMSSZ`);
      case 'other-day':
        return malformed(`the credential's date "${problem.date}" is not the request's`);
      case 'skewed':
        return new S3Error(403, 'RequestTimeTooSkewed', 'The difference between the request time and the current time is too large.');
      case 'unsigned':
        return malformed(`the ${problem.header} header must be signed`);
      case 'mismatch':
        return signatureMismatch();
    }
  };
}

/** S3, to the signature check, for a request signed in its Authorization header: its paths signed its own way. */
const S3_HEADER: SignedService = { name: 's3', paths: 'once', refuse: s3Words(malformedAuthorization, malformedAuthorization) };

/** S3 for a presigned URL: what is wrong said of the query's parameters. */
const S3_PRESIGNED: SignedService = {
  name: 's3',
  paths: 'once',
  refuse: s3Words(malformedQueryAuthorization, (detail) => malformedQueryAuthorization(`Error parsing the X-Amz-Credential parameter; ${detail}`)),
};

const QUERY_PARAMETERS = ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Signature', 'X-Amz-Date', 'X-Amz-SignedHeaders', 'X-Amz-Expires'];

/**
 * A request's signature, read but not yet checked; null for an anonymous
 * request. FF's keys have no session token: a request that carries one is
 * refused, as a token FF never issued.
 */
export function readSignature(headers: IncomingHttpHeaders, query: URLSearchParams): RequestSignature | null {
  const header = single(headers.authorization);
  const presigned = query.has('X-Amz-Algorithm') || query.has('X-Amz-Signature') || query.has('X-Amz-Credential');
  if (header !== undefined && presigned) throw new S3Error(400, 'InvalidArgument', 'Only one auth mechanism allowed; only the X-Amz-Algorithm query parameter or the Authorization header should be specified');
  if (headers['x-amz-security-token'] !== undefined || query.has('X-Amz-Security-Token')) throw S3_HEADER.refuse({ kind: 'token' });
  if (header !== undefined) {
    const read = readAuthorization(headers, S3_HEADER) as HeaderSignature;
    const payload = single(headers['x-amz-content-sha256']);
    if (!payload) throw invalidRequest('Missing required header for this request: x-amz-content-sha256');
    return { kind: 'header', ...read, payload };
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
    ...readCredential(query.get('X-Amz-Credential') as string, S3_PRESIGNED),
    signedHeaders: (query.get('X-Amz-SignedHeaders') as string).split(';'),
    signature: query.get('X-Amz-Signature') as string,
    amzDate: query.get('X-Amz-Date') as string,
    payload: query.get('X-Amz-Content-Sha256') ?? UNSIGNED_PAYLOAD,
    expires,
  };
}

/**
 * Checks a signature with the key's secret, as S3 does: its time (within 15
 * minutes of now in a header; a presigned URL until it expires), the signed
 * headers (host, and for a header the body's hash), then the signature itself.
 * The path is tried as S3 signs it, then as the client sent it, which some
 * clients sign. Answers what an aws-chunked body's chunks chain from.
 */
export function checkSignature(request: SignedRequest, signature: RequestSignature, secret: string, now: Date): SigningChain {
  const service = signature.kind === 'header' ? S3_HEADER : S3_PRESIGNED;
  const at = signedAt(signature, service);
  if (signature.kind === 'header') checkSkew(at, signature.amzDate, now, service);
  if (signature.kind === 'presigned') {
    if (at - now.getTime() > MAX_CLOCK_SKEW_MS) throw accessDenied('Request is not valid yet');
    if (now.getTime() > at + (signature.expires as number) * 1000) throw accessDenied('Request has expired');
  }
  requireSigned(signature.signedHeaders, 'host', service);
  if (signature.kind === 'header') requireSigned(signature.signedHeaders, 'x-amz-content-sha256', service);
  return matchSignature(request, signature, signature.payload, secret, service, signature.kind === 'presigned' ? 'X-Amz-Signature' : undefined);
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
  const signed: SignedRequest = { method: request.method, rawPath: request.rawPath, rawQuery: request.rawQuery, rawHeaders: names.flatMap((name) => [name, headers[name]]) };
  const scope = scopeOf(date, credentials.region, 's3');
  const canonical = canonicalRequest(signed, canonicalUri(request.rawPath), names, UNSIGNED_PAYLOAD);
  const signature = hmac(signingKey(credentials.secretAccessKey, date, credentials.region, 's3'), stringToSign(amzDate, scope, canonical)).toString('hex');
  return { ...headers, authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

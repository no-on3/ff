import { IncomingHttpHeaders } from 'node:http';
import { HeaderSignature, SignedRequest, SignedService, checkAuthorization, readAuthorization, serviceWords } from '../common/signature-v4';
import { incompleteSignature, invalidClientTokenId, signatureDoesNotMatch } from './sqs-error';

/** A request's signature, as its Authorization header gives it, read but not yet checked. */
export type SqsSignature = HeaderSignature;

/** SQS, to the signature check: its paths signed as every service but S3's, its refusals in SQS's words. */
const SQS: SignedService = {
  name: 'sqs',
  paths: 'twice',
  refuse: serviceWords('sqs', { incomplete: incompleteSignature, mismatch: signatureDoesNotMatch, token: invalidClientTokenId }),
};

/**
 * A request's signature, from its Authorization header, as AWS's SDKs and CLI
 * sign SQS's JSON requests; null when it has none. FF's keys have no session
 * token: a request that carries one is refused, as a token FF never issued.
 */
export function readSqsSignature(headers: IncomingHttpHeaders): SqsSignature | null {
  return readAuthorization(headers, SQS);
}

/**
 * Checks a signature with the key's secret, as SQS does: the time, within 15
 * minutes of now; the host signed; then the signature over the request and
 * the SHA-256 of its body, which SQS's clients sign without sending it.
 */
export function checkSqsSignature(request: SignedRequest, body: Buffer, signature: SqsSignature, secret: string, now: Date): void {
  checkAuthorization(request, body, signature, secret, now, SQS);
}

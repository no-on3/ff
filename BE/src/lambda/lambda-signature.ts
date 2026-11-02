import { IncomingHttpHeaders } from 'node:http';
import { HeaderSignature, SignedRequest, SignedService, checkAuthorization, readAuthorization, serviceWords } from '../common/signature-v4';
import { incompleteSignature, invalidSignature, unrecognizedClient } from './lambda-error';

/**
 * Lambda, to the signature check: its paths escaped twice, as every service
 * but S3 signs them, so that an ARN's colon, %3A on the wire, is signed %253A
 * (ADR 0014, 3); its refusals in Lambda's words.
 */
const LAMBDA: SignedService = {
  name: 'lambda',
  paths: 'twice',
  refuse: serviceWords('lambda', { incomplete: incompleteSignature, mismatch: invalidSignature, token: unrecognizedClient }),
};

/**
 * A request's signature, from its Authorization header, as AWS's SDKs, CLI
 * and Terraform's provider sign Lambda's requests; null when it has none. FF's
 * keys have no session token: a request that carries one is refused, as a
 * token FF never issued.
 */
export function readLambdaSignature(headers: IncomingHttpHeaders): HeaderSignature | null {
  return readAuthorization(headers, LAMBDA);
}

/**
 * Checks a signature with the key's secret, as Lambda does: the time, within
 * 15 minutes of now; the host signed; then the signature over the request,
 * its path escaped twice, and the SHA-256 of its body.
 */
export function checkLambdaSignature(request: SignedRequest, body: Buffer, signature: HeaderSignature, secret: string, now: Date): void {
  checkAuthorization(request, body, signature, secret, now, LAMBDA);
}

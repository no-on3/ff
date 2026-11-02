import { IncomingHttpHeaders } from 'node:http';
import { HeaderSignature, SignedRequest, SignedService, checkAuthorization, readAuthorization, serviceWords } from '../common/signature-v4';
import { incompleteSignature, signatureDoesNotMatch, unrecognizedClient } from './ses-error';

/** A request's signature, as its Authorization header gives it, read but not yet checked. */
export type SesSignature = HeaderSignature;

/** SES v2, to the signature check: its paths escaped twice, as every service but S3 signs them (ADR 0012), its refusals in SES's words. */
const SES: SignedService = {
  name: 'ses',
  paths: 'twice',
  refuse: serviceWords('ses', { incomplete: incompleteSignature, mismatch: signatureDoesNotMatch, token: unrecognizedClient }),
};

/**
 * A request's signature, from its Authorization header, as AWS's SDKs and CLI
 * sign SES v2's requests; null when it has none. FF's keys have no session
 * token: a request that carries one is refused, as a token FF never issued.
 */
export function readSesSignature(headers: IncomingHttpHeaders): SesSignature | null {
  return readAuthorization(headers, SES);
}

/**
 * Checks a signature with the key's secret, as SES does: the time, within 15
 * minutes of now; the host signed; then the signature over the request, its
 * path escaped twice, and the SHA-256 of its body.
 */
export function checkSesSignature(request: SignedRequest, body: Buffer, signature: SesSignature, secret: string, now: Date): void {
  checkAuthorization(request, body, signature, secret, now, SES);
}

import { escapeXml } from './xml';

/**
 * An answer the front door gives itself, in S3's words: its status, its code
 * and its message, as AWS's SDKs and CLI read them from the XML error body.
 */
export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

export const accessDenied = (message = 'Access Denied') => new S3Error(403, 'AccessDenied', message);

export const invalidAccessKeyId = () => new S3Error(403, 'InvalidAccessKeyId', 'The AWS Access Key Id you provided does not exist in our records.');

export const signatureMismatch = () =>
  new S3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided. Check your key and signing method.');

export const malformedAuthorization = (detail: string) => new S3Error(400, 'AuthorizationHeaderMalformed', `The authorization header is malformed; ${detail}`);

export const malformedQueryAuthorization = (detail: string) => new S3Error(400, 'AuthorizationQueryParametersError', detail);

export const invalidRequest = (message: string) => new S3Error(400, 'InvalidRequest', message);

export const noSuchBucket = () => new S3Error(404, 'NoSuchBucket', 'The specified bucket does not exist');

export const notImplemented = () => new S3Error(501, 'NotImplemented', 'A header you provided implies functionality that is not implemented');

export const incompleteBody = (message = 'You did not provide the number of bytes specified by the Content-Length HTTP header.') =>
  new S3Error(400, 'IncompleteBody', message);

export const badDigest = (algorithm: string) => new S3Error(400, 'BadDigest', `The ${algorithm.toUpperCase()} you specified did not match the calculated checksum.`);

export const internalError = () => new S3Error(500, 'InternalError', 'We encountered an internal error. Please try again.');

/** The account can't do it, in AWS's words for a suspended account's requests, and why. */
export const accountProblem = (why: string) =>
  new S3Error(403, 'AccountProblem', `There is a problem with your FF account that prevents the action from completing successfully: ${why}.`);

/** S3's error document: its code and message, the resource asked for, and the request's ID. */
export function errorDocument(error: S3Error, requestId: string, resource?: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<Error>' +
    `<Code>${escapeXml(error.code)}</Code><Message>${escapeXml(error.message)}</Message>` +
    (resource ? `<Resource>${escapeXml(resource)}</Resource>` : '') +
    `<RequestId>${escapeXml(requestId)}</RequestId></Error>`
  );
}

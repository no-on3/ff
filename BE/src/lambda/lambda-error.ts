/**
 * An error as AWS Lambda answers it, in its REST JSON protocol (ADR 0014): an
 * HTTP status, the error's name in the `x-amzn-ErrorType` header, which AWS's
 * SDKs and CLI name the error by, and a JSON body with whose fault it is
 * (`Type`: the caller's, or the service's) and its message.
 */
export class LambdaError extends Error {
  constructor(
    readonly status: number,
    /** The error's name, as Lambda's model has it. */
    readonly type: string,
    message: string,
    /** What the error adds to its body, as Lambda's model has it: a throttle's Reason. */
    readonly fields: Record<string, string> = {},
    /** Headers the answer carries beside the error's name: a throttle's Retry-After. */
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  /** The JSON body Lambda answers. */
  document(): Record<string, string> {
    return { Type: this.status < 500 ? 'User' : 'Service', message: this.message, ...this.fields };
  }
}

export const missingAuthenticationToken = () => new LambdaError(403, 'MissingAuthenticationTokenException', 'Missing Authentication Token');
export const unrecognizedClient = () => new LambdaError(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
export const expiredToken = () => new LambdaError(403, 'ExpiredTokenException', 'The security token included in the request is expired');
export const incompleteSignature = (message: string) => new LambdaError(400, 'IncompleteSignatureException', message);
export const invalidSignature = (
  message = 'The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method. Consult the service documentation for details.',
) => new LambdaError(403, 'InvalidSignatureException', message);
export const accessDenied = (message: string) => new LambdaError(403, 'AccessDeniedException', message);
export const resourceNotFound = (message: string) => new LambdaError(404, 'ResourceNotFoundException', message);
export const invalidParameterValue = (message: string) => new LambdaError(400, 'InvalidParameterValueException', message);
export const invalidRequestContent = (message: string) => new LambdaError(400, 'InvalidRequestContentException', message);
export const requestEntityTooLarge = (limit: number, operation: string) =>
  new LambdaError(413, 'RequestEntityTooLargeException', `Request must be smaller than ${limit} bytes for the ${operation} operation`);
/** Over one of the plan's rates: Lambda's throttle, its Reason the caller's rate, and the seconds to wait. */
export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new LambdaError(429, 'TooManyRequestsException', message, { Reason: 'CallerRateLimitExceeded' }, { 'retry-after': String(retryAfterSeconds) });
/** An operation FF doesn't offer: 400, which no client tries again. */
export const unknownOperation = (message: string) => new LambdaError(400, 'UnknownOperationException', message);
export const serviceException = () => new LambdaError(500, 'ServiceException', 'The AWS Lambda service encountered an internal error.');

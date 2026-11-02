import { HttpException } from '@nestjs/common';
import { functionArn } from '../functions/arns';
import { ChangeUnderWayException } from '../functions/change-under-way';
import { FunctionStatus } from '../functions/entities/function.entity';

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
export const resourceConflict = (message: string) => new LambdaError(409, 'ResourceConflictException', message);
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

/** Lambda's name for each refusal of FF's API that its services give: the same status, the same message. */
const NAMES: Record<number, string> = {
  400: 'InvalidParameterValueException',
  403: 'AccessDeniedException',
  404: 'ResourceNotFoundException',
  409: 'ResourceConflictException',
  412: 'PreconditionFailedException',
  413: 'RequestEntityTooLargeException',
  429: 'TooManyRequestsException',
};

/**
 * A change refused while another runs, in Lambda's own words, which the tools
 * wait on: a function being created is Pending, else an update is in
 * progress, the function named by its ARN in `region`.
 */
function changeUnderWay({ function_ }: ChangeUnderWayException, region: string): LambdaError {
  return resourceConflict(
    function_.status === FunctionStatus.CREATING
      ? 'The operation cannot be performed at this time. The function is currently in the following state: Pending'
      : `The operation cannot be performed at this time. An update is in progress for resource: ${functionArn(region, function_.accountId, function_.name)}`,
  );
}

/**
 * A refusal of FF's services, which FF's API answers, as Lambda's: its status
 * and its message, under the name Lambda gives that status, or the one of
 * Lambda's that the refusal names (CodeStorageExceededException); a change
 * refused while another runs in Lambda's words, its function in `region`; a
 * failure of the platform's, 500 or 503, Lambda's ServiceException, which the
 * SDKs try again.
 */
export function lambdaErrorOf(error: HttpException, region: string): LambdaError {
  if (error instanceof ChangeUnderWayException) return changeUnderWay(error, region);
  const status = error.getStatus();
  const answer = error.getResponse();
  const { message: said, error: named } = typeof answer === 'string' ? { message: answer, error: undefined } : (answer as { message?: unknown; error?: unknown });
  const message = Array.isArray(said) ? said.join('; ') : typeof said === 'string' ? said : error.message;
  if (status >= 500) return new LambdaError(status, 'ServiceException', message);
  const lambdas = typeof named === 'string' && /^[A-Z][A-Za-z]+Exception$/.test(named) ? named : undefined;
  return new LambdaError(status, lambdas ?? NAMES[status] ?? 'InvalidRequestContentException', message);
}

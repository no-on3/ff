/**
 * An error as Amazon SQS answers it in its JSON protocol: an HTTP status, the
 * body's `__type`, which AWS's SDK for JavaScript names the error by, and the
 * `x-amzn-query-error` header, `<code>;<Sender|Receiver>`, which boto3 and the
 * AWS CLI show, as SQS's older protocol named it (ADR 0010).
 */
export class SqsError extends Error {
  constructor(
    readonly status: number,
    /** The `__type`'s name, after `com.amazonaws.sqs#`. */
    readonly type: string,
    message: string,
    /** The query protocol's code, when it isn't the type's. */
    readonly queryCode: string = type,
    readonly fault: 'Sender' | 'Receiver' = 'Sender',
  ) {
    super(message);
  }

  /** The JSON body SQS answers. */
  document(): { __type: string; message: string } {
    return { __type: `com.amazonaws.sqs#${this.type}`, message: this.message };
  }

  /** The header boto3 and the AWS CLI read the error's name from. */
  queryError(): string {
    return `${this.queryCode};${this.fault}`;
  }
}

export const queueDoesNotExist = () => new SqsError(400, 'QueueDoesNotExist', 'The specified queue does not exist.', 'AWS.SimpleQueueService.NonExistentQueue');
export const invalidParameter = (message: string) => new SqsError(400, 'InvalidParameterValue', message);
export const missingParameter = (name: string) => new SqsError(400, 'MissingParameter', `The request must contain the parameter ${name}.`);
export const invalidAttributeName = (message: string) => new SqsError(400, 'InvalidAttributeName', message);
export const invalidAttributeValue = (message: string) => new SqsError(400, 'InvalidAttributeValue', message);
export const receiptHandleIsInvalid = (handle: string) => new SqsError(400, 'ReceiptHandleIsInvalid', `The input receipt handle "${handle}" is not a valid receipt handle.`);
export const accessDenied = (message = 'Access to the resource is denied.') => new SqsError(403, 'AccessDenied', message, 'AccessDenied');
export const invalidClientTokenId = () => new SqsError(403, 'InvalidClientTokenId', 'The security token included in the request is invalid.');
export const signatureDoesNotMatch = (message = 'The request signature we calculated does not match the signature you provided.') =>
  new SqsError(403, 'SignatureDoesNotMatch', message);
export const missingAuthenticationToken = () => new SqsError(403, 'MissingAuthenticationToken', 'Request is missing Authentication Token');
export const incompleteSignature = (message: string) => new SqsError(400, 'IncompleteSignature', message);
export const requestThrottled = (message: string) => new SqsError(400, 'RequestThrottled', message);
export const overLimit = (message: string) => new SqsError(400, 'OverLimit', message);
export const unsupportedOperation = (message: string) => new SqsError(400, 'UnsupportedOperation', message, 'AWS.SimpleQueueService.UnsupportedOperation');
export const internalError = () => new SqsError(500, 'InternalError', 'We encountered an internal error. Please try again.', 'InternalError', 'Receiver');

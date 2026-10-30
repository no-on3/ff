/**
 * An error as Amazon SES v2 answers it, in AWS's REST JSON protocol (ADR
 * 0012): an HTTP status, the error's name in the `x-amzn-ErrorType` header,
 * which AWS's SDKs and CLI name the error by, and a JSON body with its
 * message.
 */
export class SesError extends Error {
  constructor(
    readonly status: number,
    /** The error's name, as SES v2's model has it. */
    readonly type: string,
    message: string,
  ) {
    super(message);
  }

  /** The `x-amzn-ErrorType` header's value, as AWS's services write it. */
  errorType(): string {
    return `${this.type}:http://internal.amazon.com/coral/com.amazon.coral.service/`;
  }

  /** The JSON body SES answers. */
  document(): { message: string } {
    return { message: this.message };
  }
}

export const badRequest = (message: string) => new SesError(400, 'BadRequestException', message);
export const notFound = (message: string) => new SesError(404, 'NotFoundException', message);
export const alreadyExists = (message: string) => new SesError(400, 'AlreadyExistsException', message);
export const limitExceeded = (message: string) => new SesError(400, 'LimitExceededException', message);
export const tooManyRequests = (message: string) => new SesError(429, 'TooManyRequestsException', message);
export const messageRejected = (message: string) => new SesError(400, 'MessageRejected', message);
export const mailFromDomainNotVerified = (message: string) => new SesError(400, 'MailFromDomainNotVerifiedException', message);
export const accountSuspended = (message: string) => new SesError(400, 'AccountSuspendedException', message);
export const sendingPaused = (message: string) => new SesError(400, 'SendingPausedException', message);
export const notImplemented = (message: string) => new SesError(501, 'NotImplemented', message);
export const accessDenied = (message: string) => new SesError(403, 'AccessDeniedException', message);
export const unrecognizedClient = () => new SesError(403, 'UnrecognizedClientException', 'The security token included in the request is invalid.');
export const missingAuthenticationToken = () => new SesError(403, 'MissingAuthenticationTokenException', 'Missing Authentication Token');
export const incompleteSignature = (message: string) => new SesError(400, 'IncompleteSignatureException', message);
export const signatureDoesNotMatch = (
  message = 'The request signature we calculated does not match the signature you provided. Check your AWS Secret Access Key and signing method.',
) => new SesError(403, 'SignatureDoesNotMatch', message);
export const requestTooLarge = (limit: number) => new SesError(413, 'RequestEntityTooLargeException', `The request is over ${limit} bytes.`);
export const internalFailure = () => new SesError(500, 'InternalFailure', 'The request processing has failed because of an unknown error, exception or failure.');

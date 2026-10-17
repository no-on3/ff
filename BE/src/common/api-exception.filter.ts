import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { describeError } from './describe-error';
import { REQUEST_ID_HEADER, requestIdOf } from './request-context';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

/** What the caller sees of a platform failure: no details, but the request ID that leads to them in the log (D4). */
export function internalErrorMessage(requestId: string): string {
  return `Internal error. Request ID: ${requestId}`;
}

/**
 * Every error answer, with the request's ID. An HttpException (the caller's
 * mistake, or a failure already worded for the caller) goes out as it is.
 * Anything else is a platform failure: 500 with a generic message, and the
 * details only in the server log (D4).
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ requestId?: string; method?: string; originalUrl?: string; url?: string }>();
    const response = http.getResponse<ErrorResponse>();
    const requestId = requestIdOf(request);
    response.setHeader(REQUEST_ID_HEADER, requestId);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response.status(status).json({ ...(typeof body === 'string' ? { statusCode: status, message: body } : body), requestId });
      return;
    }
    this.logger.error(
      `Request ${requestId} (${request.method} ${request.originalUrl ?? request.url}) failed: ${describeError(exception)}`,
      exception instanceof Error ? exception.stack : undefined,
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: internalErrorMessage(requestId),
      requestId,
    });
  }
}

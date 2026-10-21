import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
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
 * An error Express's middleware made for the caller's request, which says so
 * as the http-errors package does: a 4xx status, and `expose`. Body parsers
 * give them: a body over their limit (413), a charset or encoding they don't
 * read (415), a request cut short (400).
 */
function callersError(exception: unknown): { status: number; message: string } | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, expose, message } = exception as { status?: unknown; expose?: unknown; message?: unknown };
  if (typeof status !== 'number' || status < 400 || status > 499 || expose !== true || typeof message !== 'string') return undefined;
  return { status, message };
}

/**
 * Every error answer, with the request's ID. An HttpException (the caller's
 * mistake, or a failure already worded for the caller) goes out as it is, and
 * so does an error middleware made for the caller's request. Anything else is
 * a platform failure: 500 with a generic message, and the details only in the
 * server log (D4).
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
      const status: HttpStatus = exception.getStatus();
      const body = exception.getResponse();
      // RFC 6750: say how to authenticate.
      if (status === HttpStatus.UNAUTHORIZED) response.setHeader('WWW-Authenticate', 'Bearer realm="ff"');
      response.status(status).json({ ...(typeof body === 'string' ? { statusCode: status, message: body } : body), requestId });
      return;
    }
    const callers = callersError(exception);
    if (callers) {
      response.status(callers.status).json({ statusCode: callers.status, error: STATUS_CODES[callers.status], message: callers.message, requestId });
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

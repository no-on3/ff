import { BadRequestException, HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describeError } from '../common/describe-error';
import { currentRequestId } from '../common/request-context';
import {
  FunctionLoadError,
  FunctionRuntimeError,
  FunctionThrottledError,
} from '../orchestrator/orchestrator.errors';

/**
 * What the caller may see of a failure as it is: the function's own error, or
 * the caller's mistake. Undefined for anything else, which is a platform
 * failure (D4).
 */
export function callersFailure(error: unknown): string | undefined {
  if (error instanceof FunctionLoadError) return `The function failed to load: ${error.errorType}: ${error.message}`;
  if (error instanceof FunctionRuntimeError || error instanceof FunctionThrottledError) return `${error.errorType}: ${error.message}`;
  return undefined;
}

/**
 * A platform failure (D4): its details go to the server log with the request
 * ID; the caller, and any record it can read later, get a generic message with
 * that ID.
 */
export function platformFailure(logger: Logger, action: string, error: unknown): string {
  const requestId = currentRequestId() ?? randomUUID();
  logger.error(`${action} failed (request ${requestId}): ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
  return `${action} failed because of an internal error (request ${requestId}).`;
}

/**
 * The answer to a failure that `visible` already words for the caller, with
 * `extra` fields in its body: a failed create names the function it saved.
 */
export function failureResponse(error: unknown, visible: string, extra: Record<string, unknown> = {}): HttpException {
  if (error instanceof FunctionThrottledError) {
    return new HttpException({ statusCode: 429, error: 'Too Many Requests', message: visible, ...extra }, HttpStatus.TOO_MANY_REQUESTS);
  }
  return callersFailure(error) === undefined
    ? new InternalServerErrorException({ statusCode: 500, error: 'Internal Server Error', message: visible, ...extra })
    : new BadRequestException({ statusCode: 400, error: 'Bad Request', message: visible, ...extra });
}

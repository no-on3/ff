import { BadRequestException, HttpException, HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describeError } from '../common/describe-error';
import { currentRequestId } from '../common/request-context';
import {
  CodeTooLargeError,
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
  if (error instanceof CodeTooLargeError) return error.message;
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

/** The answer to a failure that `visible` already words for the caller. */
export function failureResponse(error: unknown, visible: string): HttpException {
  if (error instanceof FunctionThrottledError) {
    return new HttpException({ statusCode: 429, error: 'Too Many Requests', message: visible }, HttpStatus.TOO_MANY_REQUESTS);
  }
  return callersFailure(error) === undefined ? new InternalServerErrorException(visible) : new BadRequestException(visible);
}

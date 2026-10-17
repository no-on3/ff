/**
 * Errors any orchestrator driver may raise. The caller sees the function's own
 * errors and its own mistakes as they are; any other failure is the platform's,
 * and only the server log gets its details (D4).
 */

/** The scheduler could not do what was asked (deploy, readiness, routing): a platform failure. */
export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

/** The function ran and failed (it threw, ran out of memory, crashed, or could not load). */
export class FunctionRuntimeError extends Error {
  constructor(
    readonly errorType: string,
    message: string,
  ) {
    super(message);
    this.name = 'FunctionRuntimeError';
  }
}

/** The function exceeded its configured timeout. */
export class FunctionTimeoutError extends FunctionRuntimeError {
  constructor(message: string) {
    super('Sandbox.Timedout', message);
    this.name = 'FunctionTimeoutError';
  }
}

/** The function's code failed to load: the error its runtime reported at start-up. */
export class FunctionLoadError extends FunctionRuntimeError {
  constructor(errorType: string, message: string) {
    super(errorType, message);
    this.name = 'FunctionLoadError';
  }
}

/** No instance of the function could take the call in time: its runtime answered 429. */
export class FunctionThrottledError extends Error {
  readonly errorType = 'TooManyRequestsException';

  constructor(message: string) {
    super(message);
    this.name = 'FunctionThrottledError';
  }
}

/** The code does not fit the current delivery mechanism (ConfigMap, 900 KiB). */
export class CodeTooLargeError extends OrchestratorError {
  constructor(bytes: number, limit: number) {
    super(`Function code is ${bytes} bytes; the current limit is ${limit} bytes`);
    this.name = 'CodeTooLargeError';
  }
}

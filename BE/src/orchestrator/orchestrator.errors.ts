/** Errors any orchestrator driver may raise; callers map them to invocation statuses. */

/** The scheduler could not do what was asked (deploy, readiness, routing). */
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

/** The code does not fit the current delivery mechanism (ConfigMap, 900 KiB). */
export class CodeTooLargeError extends OrchestratorError {
  constructor(bytes: number, limit: number) {
    super(`Function code is ${bytes} bytes; the current limit is ${limit} bytes`);
    this.name = 'CodeTooLargeError';
  }
}

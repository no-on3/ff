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

/** What the runtime said of a call that failed, from its answer's headers: what it measured, which bills it, and the call's log when asked. */
export interface CallReport {
  durationMs?: number;
  memoryUsedMb?: number;
  /** The call's last 4 KB of log in base64, as Lambda's X-Amz-Log-Result. */
  logResult?: string;
}

/** The function ran and failed (it threw, ran out of memory, crashed, or could not load). */
export class FunctionRuntimeError extends Error {
  readonly durationMs?: number;
  readonly memoryUsedMb?: number;
  readonly logResult?: string;

  constructor(
    readonly errorType: string,
    message: string,
    report: CallReport = {},
  ) {
    super(message);
    this.name = 'FunctionRuntimeError';
    this.durationMs = report.durationMs;
    this.memoryUsedMb = report.memoryUsedMb;
    this.logResult = report.logResult;
  }
}

/** The function exceeded its configured timeout. */
export class FunctionTimeoutError extends FunctionRuntimeError {
  constructor(message: string, report: CallReport = {}) {
    super('Sandbox.Timedout', message, report);
    this.name = 'FunctionTimeoutError';
  }
}

const coldStarts = new WeakMap<object, number>();

/** Marks what a call threw with how long its cold start took, if it had one (P-20). */
export function withInitMs<T>(error: T, initMs: number | undefined): T {
  if (initMs !== undefined && typeof error === 'object' && error !== null) coldStarts.set(error, initMs);
  return error;
}

/** How long the cold start before a failed call took, if it had one. */
export function initMsOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null ? coldStarts.get(error) : undefined;
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

/** The log store could not be reached, or failed: logs can't be read for now (P-43). Its details are the platform's. */
export class LogStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogStoreUnavailableError';
  }
}

/** A logs cursor that no page gave: the caller's mistake (P-43). */
export class InvalidLogCursorError extends Error {
  constructor() {
    super('Invalid cursor: pass the next value of the page before');
    this.name = 'InvalidLogCursorError';
  }
}

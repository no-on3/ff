/**
 * Messages between the HTTP main thread (main.ts) and the worker thread that
 * hosts user code (worker.ts). Runtime protocol v3.
 */

/**
 * What the worker writes to its stdout and to its stderr once a call has
 * settled, before it posts the result. The main thread forwards the worker's
 * output itself, takes the markers out, and prints END only after both, so a
 * call's output always comes before its END in the log (client-readiness
 * plan, P-42; ADR 0005): the log store tags a call's lines from START to REPORT.
 */
export const END_OF_CALL = '\u0000ff-end-of-call:';

/**
 * How the payload of POST /invoke reaches the handler (FF_EVENT_FORMAT):
 * - `lambda`, the default: the payload is the event itself, any JSON value, as on AWS Lambda;
 * - `wrapped`: inside FF's original wrapper (WrappedEvent), for functions made before protocol 3.
 */
export const EVENT_FORMATS = ['lambda', 'wrapped'] as const;
export type EventFormat = (typeof EVENT_FORMATS)[number];

/** FF's original wrapper: the payload in `body`, and the request to the runtime around it. Protocol 2's only event. */
export interface WrappedEvent {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  query: Record<string, string>;
  path: string;
}

export interface WorkerConfig {
  taskRoot: string;
  /** "<file>.<export>", e.g. "function.handler" or "src/app.handler". */
  handler: string;
  functionName: string;
  functionVersion: string;
  memoryLimitMb: number;
}

export interface InvokeMessage {
  type: 'invoke';
  id: number;
  requestId: string;
  /** The payload itself, or the wrapper around it (EventFormat). */
  event: unknown;
  /** Epoch milliseconds at which the invocation times out. */
  deadlineMs: number;
}

export interface FunctionError {
  errorType: string;
  errorMessage: string;
}

export type WorkerMessage =
  | { type: 'ready' }
  | ({ type: 'init_error' } & FunctionError)
  /** `body` is the JSON text of the handler's return value. */
  | { type: 'result'; id: number; ok: true; body: string }
  /**
   * `stackTrace` is set when the handler threw (its frames in user code, possibly
   * none), and absent for the runtime's own errors, such as Runtime.MarshalError.
   */
  | ({ type: 'result'; id: number; ok: false; stackTrace?: string[] } & FunctionError);

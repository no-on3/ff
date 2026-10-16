/**
 * Messages between the HTTP main thread (main.ts) and the worker thread that
 * hosts user code (worker.ts). Runtime protocol v1.
 */

/** The event passed to handlers. Unchanged from the original FF wrapper. */
export interface FunctionEvent {
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
  event: FunctionEvent;
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
  | ({ type: 'result'; id: number; ok: false } & FunctionError);

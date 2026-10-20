import { Runtime } from '../functions/entities/function.entity';

/** Injection token for the active scheduler driver (see OrchestratorModule). */
export const ORCHESTRATOR = Symbol('ORCHESTRATOR');

/**
 * Everything a scheduler needs to run one function. The Function entity
 * satisfies this shape structurally, so services can pass entities directly.
 * Methods take the whole workload, not just an ID, because some drivers
 * (Kubernetes) also need the account to locate resources.
 */
export interface FunctionWorkload {
  id: string;
  name: string;
  /** The account that owns the function (D1): it names the namespace. */
  accountId: string;
  runtime: Runtime;
  code: string;
  /** Memory in MB. */
  memory: number;
  /** Timeout in seconds. */
  timeout: number;
  minInstances: number;
  maxInstances: number;
}

/** One line of a function's log (P-40), in the shape the log store gives too (P-43). */
export interface FunctionLogLine {
  /** When it was written: RFC 3339, UTC, with nine decimals. */
  time: string;
  /** The instance that wrote it; null for the log store's own notices. */
  instance: string | null;
  /** The call it belongs to, from its START to its REPORT; null outside a call. */
  requestId: string | null;
  /** stdout or stderr; ff for the collector's notice of dropped lines; null if unknown. */
  stream: 'stdout' | 'stderr' | 'ff' | null;
  message: string;
}

/** Which of a function's lines (P-43): all, or only a call's, or only those with a phrase. */
export interface LogsFilter {
  /** Only lines with this phrase. */
  q?: string;
  /** Only the lines of this call. */
  requestId?: string;
}

/** Which lines to read (P-43): the newest `limit` of the window, or of what comes before `cursor`. */
export interface LogsQuery extends LogsFilter {
  /** The window: from `start`, included, to `end`, excluded. */
  start: Date;
  end: Date;
  limit: number;
  /** Where the page before ended: its `next`. */
  cursor?: string;
}

/** A page of lines, oldest first, and where the older ones start; null when there are none. */
export interface FunctionLogsPage {
  lines: FunctionLogLine[];
  next: string | null;
}

/** What a scheduler applies to an account as a whole: its plan's quota (D5). */
export interface TenantLimits {
  /** All the account's functions together. */
  quota: { pods: number; cpu: string; memory: string };
}

export interface InvokeResult {
  /** The value returned by the function handler. */
  output: unknown;
  durationMs?: number;
  memoryUsedMb?: number;
  /** How long the call waited for an instance to start from zero: a cold start (P-20). */
  initMs?: number;
}

export interface Orchestrator {
  /**
   * Create or replace everything needed to run the function, with at least one
   * instance, and its account's limits. Idempotent.
   */
  deploy(fn: FunctionWorkload, tenant: TenantLimits): Promise<void>;
  /**
   * Roll out new code or configuration for an existing function, with at least
   * one instance even if it was scaled to zero, so that waitUntilReady checks a
   * real instance. Applying a previous version again is how an update is undone.
   * The account's limits are applied again too.
   */
  update(fn: FunctionWorkload, tenant: TenantLimits): Promise<void>;
  /** Apply an account's new limits at once, after a plan change. Nothing to do before its first function. */
  applyTenantLimits(accountId: string, tenant: TenantLimits): Promise<void>;
  /** Delete every scheduler resource of the function. */
  remove(fn: FunctionWorkload): Promise<void>;
  /**
   * Delete the account's namespace and everything in it, and wait until it is
   * gone (P-45, closing an account). Nothing to do when it has none.
   */
  removeTenant(accountId: string): Promise<void>;
  /**
   * Delete every line of the account's functions from the log store, and check
   * that none is left (P-45). Doing it again is harmless.
   */
  deleteLogs(accountId: string): Promise<void>;
  /**
   * Resolve once the rollout is complete: every desired instance runs the
   * current version and can serve. Reject with diagnostics on timeout.
   */
  waitUntilReady(fn: FunctionWorkload, timeoutMs: number): Promise<void>;
  /**
   * Calls the function. `requestId` goes to the runtime (X-FF-Request-Id), so the
   * invocation, its usage record and its log lines share one ID (D6). An error
   * after a cold start carries its duration: initMsOf().
   */
  invoke(fn: FunctionWorkload, payload: Record<string, unknown>, requestId?: string): Promise<InvokeResult>;
  scale(fn: FunctionWorkload, replicas: number): Promise<void>;
  /** Instances that can serve now. */
  readyInstances(fn: FunctionWorkload): Promise<number>;
  /** Instances asked for, ready or starting (0 when the function has none). */
  desiredInstances(fn: FunctionWorkload): Promise<number>;
  /**
   * Every function with at least one ready instance, by function ID, with how
   * many: FF's capacity at this moment, from one call (P-21).
   */
  readyInstancesByFunction(): Promise<Map<string, number>>;
  /** Whether the cluster answers, within `timeoutMs`: for the readiness probe. Rejects with why not. */
  ping(timeoutMs: number): Promise<void>;
  /**
   * A page of the function's log lines, from the log store (P-43), which keeps
   * them after their instance is gone. Rejects with LogStoreUnavailableError when
   * the store can't answer, and InvalidLogCursorError for a cursor no page gave.
   */
  logs(fn: FunctionWorkload, query: LogsQuery): Promise<FunctionLogsPage>;
  /**
   * The function's lines as the log store gets them (P-43), until `signal`
   * aborts. Reading them starts the tail; it throws LogStoreUnavailableError
   * when the store can't start it, or fails later.
   */
  tailLogs(fn: FunctionWorkload, filter: LogsFilter, signal: AbortSignal): AsyncIterable<FunctionLogLine>;
}

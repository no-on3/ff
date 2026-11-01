import { EventFormat, Runtime } from '../functions/entities/function.entity';

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
  /** What its runtime calls: AWS Lambda's handler, function.handler unless it names another. */
  handler: string;
  /**
   * The code's image, by digest, as the cluster's nodes pull it (ADR 0003): its pods mount it at /var/task, inline
   * code's too. A deploy or an update needs it, and is refused without; scaling, calls and removal don't.
   */
  codeImage?: string;
  /** Memory in MB. */
  memory: number;
  /** Timeout in seconds. */
  timeout: number;
  minInstances: number;
  maxInstances: number;
  /** What its handler gets as its event: the payload itself, or FF's original wrapper around it. */
  eventFormat: EventFormat;
  /** Its variables and secrets; none when absent or empty. */
  environment?: WorkloadEnvironment;
  /** The version it runs, as it was published: none for $LATEST, the function as it is (ADR 0015). */
  version?: number;
  /** The function's last version published, 0 or none for none: once it has one, $LATEST's pods carry a label of their own. */
  lastVersion?: number;
}

/** A function by what finds its objects: its ID and its account's, which names its namespace. */
export type FunctionRef = Pick<FunctionWorkload, 'id' | 'accountId'>;

/** A published version of a function, by what names it: its function, the function's account, and its number. */
export type PublishedVersion = FunctionRef & { version: number };

/** One of a function's Deployments, $LATEST's or a version's, with the instances asked of it and those ready. */
export interface WorkloadInstances {
  functionId: string;
  /** The version it runs; none for $LATEST. */
  version?: number;
  desired: number;
  ready: number;
}

/** What a function's process gets besides FF's own variables: its variables and its secrets' values. */
export interface WorkloadEnvironment {
  /** Random, new with every change of the values: the Deployment names it, so a change rolls out. Says nothing about them. */
  revision: string;
  values: Record<string, string>;
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

/** What a scheduler applies to an account as a whole: its plan's quota, and whether its functions may reach the internet. */
export interface TenantLimits {
  /** All the account's functions together. */
  quota: { pods: number; cpu: string; memory: string };
  /**
   * The account's own setting, which the operator changes in the admin dashboard (accounts.internet_egress). The
   * platform's K8S_EGRESS_INTERNET=false still cuts every account off.
   */
  internetEgress: boolean;
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
  /**
   * Apply an account's new limits at once: after a plan change, or internet egress turned on or off. Nothing to
   * do before its first function.
   */
  applyTenantLimits(accountId: string, tenant: TenantLimits): Promise<void>;
  /** Delete every scheduler resource of the function, those of the `versions` named among them. */
  remove(fn: FunctionWorkload, versions?: number[]): Promise<void>;
  /**
   * Make what a version needs to run, with at least one instance, from its workload as it was published (its
   * `version`, its code image and its environment), and its function's $LATEST onto a label of its own first, so that
   * the two never share a call (ADR 0015). Idempotent.
   */
  deployVersion(fn: FunctionWorkload): Promise<void>;
  /**
   * Start moving $LATEST's pods onto a label of their own as a version of its function is published (ADR 0015): in its
   * Deployment's template, which rolls them, without waiting, so that a version's first call seldom waits for that
   * rollout; deployVersion finishes the move. Nothing to do once done.
   */
  labelLatest(fn: FunctionRef): Promise<void>;
  /** Delete what a version runs on; nothing to do for one that has nothing. */
  removeVersion(version: PublishedVersion): Promise<void>;
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
   * Calls the function, or the version `fn.version` names. `requestId` goes to the runtime (X-FF-Request-Id), so the
   * invocation, its usage record and its log lines share one ID. An error after a cold start carries its
   * duration: initMsOf(). `deploy` gives a version's workload whole, its code image and environment, which the call
   * asks for only when the version has nothing to run on: its first call, or its first since it went idle; the cold
   * start's duration counts its making.
   */
  invoke(fn: FunctionWorkload, payload: unknown, requestId?: string, deploy?: () => Promise<FunctionWorkload>): Promise<InvokeResult>;
  scale(fn: FunctionWorkload, replicas: number): Promise<void>;
  /** Instances that can serve now, of the version `fn.version` names, or $LATEST's. */
  readyInstances(fn: FunctionWorkload): Promise<number>;
  /** Instances asked for, ready or starting, of the version `fn.version` names, or $LATEST's (0 when it has none). */
  desiredInstances(fn: FunctionWorkload): Promise<number>;
  /**
   * The Deployments of the function, $LATEST's and its versions', or of every
   * function without one: each with its instances, asked for and ready, from
   * one call. A function's instances count together against its maxInstances
   * (ADR 0015), and a version's go when it is idle; the capacity samples take
   * each one's ready instances apart.
   */
  workloads(fn?: FunctionRef): Promise<WorkloadInstances[]>;
  /**
   * The code image each function's $LATEST pods mount, by function ID, from one
   * call: to find those whose image the registry has lost. None for a function
   * whose pods mount their code from elsewhere, as a code ConfigMap from before.
   */
  codeImagesByFunction(): Promise<Map<string, string>>;
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

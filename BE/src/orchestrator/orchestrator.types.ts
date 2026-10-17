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
   * Resolve once the rollout is complete: every desired instance runs the
   * current version and can serve. Reject with diagnostics on timeout.
   */
  waitUntilReady(fn: FunctionWorkload, timeoutMs: number): Promise<void>;
  invoke(fn: FunctionWorkload, payload: Record<string, unknown>): Promise<InvokeResult>;
  scale(fn: FunctionWorkload, replicas: number): Promise<void>;
  /** Instances that can serve now. */
  readyInstances(fn: FunctionWorkload): Promise<number>;
  /** Instances asked for, ready or starting (0 when the function has none). */
  desiredInstances(fn: FunctionWorkload): Promise<number>;
}

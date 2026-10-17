import { Runtime } from '../functions/entities/function.entity';

/** Injection token for the active scheduler driver (see OrchestratorModule). */
export const ORCHESTRATOR = Symbol('ORCHESTRATOR');

/**
 * Everything a scheduler needs to run one function. The Function entity
 * satisfies this shape structurally, so services can pass entities directly.
 * Methods take the whole workload, not just an ID, because some drivers
 * (Kubernetes) also need the tenant to locate resources.
 */
export interface FunctionWorkload {
  id: string;
  name: string;
  userId: string;
  runtime: Runtime;
  code: string;
  /** Memory in MB. */
  memory: number;
  cpu?: number;
  /** Timeout in seconds. */
  timeout: number;
  minInstances: number;
  maxInstances: number;
}

export interface InvokeResult {
  /** The value returned by the function handler. */
  output: unknown;
  durationMs?: number;
  memoryUsedMb?: number;
  cpuUsed?: number;
}

export interface Orchestrator {
  /** Create or replace everything needed to run the function, with at least one instance. Idempotent. */
  deploy(fn: FunctionWorkload): Promise<void>;
  /**
   * Roll out new code or configuration for an existing function, with at least
   * one instance even if it was scaled to zero, so that waitUntilReady checks a
   * real instance. Applying a previous version again is how an update is undone.
   */
  update(fn: FunctionWorkload): Promise<void>;
  /** Delete every scheduler resource of the function. */
  remove(fn: FunctionWorkload): Promise<void>;
  /**
   * Resolve once the rollout is complete: every desired instance runs the
   * current version and can serve. Reject with diagnostics on timeout.
   */
  waitUntilReady(fn: FunctionWorkload, timeoutMs: number): Promise<void>;
  invoke(fn: FunctionWorkload, payload: Record<string, unknown>): Promise<InvokeResult>;
  scale(fn: FunctionWorkload, replicas: number): Promise<void>;
  readyInstances(fn: FunctionWorkload): Promise<number>;
}

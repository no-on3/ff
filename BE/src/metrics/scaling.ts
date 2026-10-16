/**
 * Pure scaling decisions, so they can be reasoned about and tested without
 * timers or a scheduler. Replaces the inline logic of checkScalingConditions,
 * which divided by zero at 0 instances, scaled up without bound, ignored
 * minInstances/maxInstances, and compared CPU *ticks* to a percentage.
 */

export interface ScalingInput {
  activeInstances: number;
  /** Invocations in the last aggregation window. */
  requestCount: number;
  responseTimeP95: number;
  minInstances: number;
  maxInstances: number;
  maxRequestsPerInstance: number;
}

/** Response time above which a function gets one more instance. */
export const SLOW_P95_MS = 1000;

/**
 * Returns the new replica count, or null to leave the function alone. Moves by
 * at most one instance per window, stays within [minInstances, maxInstances],
 * and never removes the last instance while there is traffic (scale to zero is
 * the idle sweep's job).
 */
export function decideReplicas(input: ScalingInput): number | null {
  const current = Math.max(0, input.activeInstances);
  const floor = Math.max(0, input.minInstances, input.requestCount > 0 ? 1 : 0);
  const ceiling = Math.max(floor, input.maxInstances);
  const perInstance = input.requestCount / Math.max(1, current);

  let target = current;
  if (perInstance > input.maxRequestsPerInstance || input.responseTimeP95 > SLOW_P95_MS) {
    target = current + 1;
  } else if (perInstance < input.maxRequestsPerInstance * 0.6) {
    target = current - 1;
  }
  target = Math.min(ceiling, Math.max(floor, target));
  return target === current ? null : target;
}

export interface IdleInput {
  scaleToZero: boolean;
  minInstances: number;
  readyInstances: number;
  /** Epoch ms of the last invocation (or of the last deploy / process start if unknown). */
  lastActivityMs: number;
  nowMs: number;
  idleSeconds: number;
}

/** True when an eligible function has been idle long enough to scale to zero. */
export function shouldScaleToZero(input: IdleInput): boolean {
  return (
    input.scaleToZero &&
    input.minInstances === 0 &&
    input.readyInstances > 0 &&
    input.nowMs - input.lastActivityMs >= input.idleSeconds * 1000
  );
}

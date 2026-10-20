/**
 * Pure scaling decisions (client-readiness plan, D14), so they can be reasoned
 * about and tested without timers or a scheduler.
 *
 * Each instance serves one call at a time, as on Lambda, so the signal is
 * concurrency: the calls in flight at once. As soon as a call finds every
 * instance busy, the backend raises the replica count (burstTarget). Once a
 * minute, decideReplicas steps it back down, one instance at a time, but never
 * below one while the function has instances or traffic: scaling to zero is
 * the idle sweep's job (shouldScaleToZero).
 */

export interface ScalingInput {
  /** The Deployment's replica count, ready or starting. */
  desiredInstances: number;
  /** The most calls in flight at once during the window, those still running included. */
  peakConcurrency: number;
  minInstances: number;
  maxInstances: number;
}

/**
 * Returns the new replica count, or null to leave the function alone. Raises
 * to what the peak needed at once; lowers by one per window, so a short lull
 * doesn't take the capacity of a busy function away; stays within
 * [minInstances, maxInstances].
 */
export function decideReplicas(input: ScalingInput): number | null {
  const current = Math.max(0, input.desiredInstances);
  const floor = Math.max(0, input.minInstances, current > 0 || input.peakConcurrency > 0 ? 1 : 0);
  const ceiling = Math.max(floor, input.maxInstances);
  const wanted = Math.min(ceiling, Math.max(floor, input.peakConcurrency));
  if (wanted > current) return wanted; // normally done already, as the calls arrived
  if (wanted < current) return current - 1;
  return null;
}

/** The replica count for calls that found every instance busy: one per call in flight, up to maxInstances. */
export function burstTarget(inFlight: number, maxInstances: number): number {
  return Math.max(1, Math.min(maxInstances, inFlight));
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

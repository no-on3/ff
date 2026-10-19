/** Minutes before each retry of a delivery that failed: up to 5 retries after the first attempt. */
export const RETRY_MINUTES = [1, 2, 4, 8, 16] as const;
/** Every attempt a delivery gets, the first one included. */
export const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

/** When to try again a delivery whose attempts so far all failed, or null when it has had them all. */
export function nextAttempt(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + RETRY_MINUTES[Math.max(attempts, 1) - 1] * 60_000);
}

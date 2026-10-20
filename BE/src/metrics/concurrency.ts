/**
 * Calls in flight per function, and the most at once since the last read: the
 * scaling signal (client-readiness plan, D14). Each instance serves one call at
 * a time, as on Lambda, so a function needs as many instances as it has calls
 * in flight. The backend sends every call, so with one backend replica this
 * count is exact; several replicas would need the runtimes to report it.
 */
export class ConcurrencyTracker {
  private readonly inFlight = new Map<string, number>();
  private readonly peaks = new Map<string, number>();

  /** A call starts; returns how many are now in flight for the function, this one included. */
  begin(functionId: string): number {
    const count = (this.inFlight.get(functionId) ?? 0) + 1;
    this.inFlight.set(functionId, count);
    this.peaks.set(functionId, Math.max(this.peaks.get(functionId) ?? 0, count));
    return count;
  }

  /** A call ends, whatever its outcome. */
  end(functionId: string): void {
    const count = (this.inFlight.get(functionId) ?? 0) - 1;
    if (count > 0) this.inFlight.set(functionId, count);
    else this.inFlight.delete(functionId);
  }

  current(functionId: string): number {
    return this.inFlight.get(functionId) ?? 0;
  }

  /** The most calls in flight at once since the last read, then a new window starts with those still running. */
  takePeak(functionId: string): number {
    const now = this.current(functionId);
    const peak = Math.max(this.peaks.get(functionId) ?? 0, now);
    if (now > 0) this.peaks.set(functionId, now);
    else this.peaks.delete(functionId);
    return peak;
  }
}

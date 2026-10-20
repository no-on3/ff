import { ConcurrencyTracker } from './concurrency';

describe('ConcurrencyTracker', () => {
  it('counts the calls in flight per function', () => {
    const tracker = new ConcurrencyTracker();

    expect([tracker.begin('a'), tracker.begin('a'), tracker.begin('b')]).toEqual([1, 2, 1]);
    tracker.end('a');
    expect([tracker.current('a'), tracker.current('b'), tracker.current('c')]).toEqual([1, 1, 0]);
  });

  it('never counts below zero', () => {
    const tracker = new ConcurrencyTracker();
    tracker.end('a');

    expect(tracker.begin('a')).toBe(1);
  });

  it('reports the most calls at once since the last read, then starts a new window', () => {
    const tracker = new ConcurrencyTracker();
    tracker.begin('a');
    tracker.begin('a');
    tracker.begin('a');
    tracker.end('a');
    tracker.end('a');

    expect(tracker.takePeak('a')).toBe(3);
    // The new window starts with the call still running...
    expect(tracker.takePeak('a')).toBe(1);
    // ...which counts in the window where it ends, too.
    tracker.end('a');
    expect(tracker.takePeak('a')).toBe(1);
    expect(tracker.takePeak('a')).toBe(0);
    expect(tracker.takePeak('never-called')).toBe(0);
  });
});

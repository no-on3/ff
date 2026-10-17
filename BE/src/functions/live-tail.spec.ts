/** L1 for the live tail's events (P-43): lines, pings, the end after 30 minutes, a failure, a client that goes. */
import type { MessageEvent } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { FunctionLogLine } from '../orchestrator/orchestrator.types';
import { LIVE_TAIL_MS, PING_MS, TAIL_ENDED, TAIL_UNAVAILABLE, liveTail } from './live-tail';

const line = (message: string): FunctionLogLine => ({
  time: '2026-10-17T10:00:00.000000000Z',
  instance: 'fn-a',
  requestId: null,
  stream: 'stdout',
  message,
});

/** Lines handed out one at a time, as a store's tail gives them; an Error makes the tail fail. */
function source() {
  const queue: Array<FunctionLogLine | Error> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const lines = (async function* () {
    for (;;) {
      while (queue.length > 0) {
        const next = queue.shift()!;
        if (next instanceof Error) throw next;
        yield next;
      }
      if (ended) return;
      await new Promise<void>((resolve) => (wake = resolve));
    }
  })();
  return {
    lines,
    push(...items: Array<FunctionLogLine | Error>) {
      queue.push(...items);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

function watch(stream: Observable<MessageEvent>) {
  const events: MessageEvent[] = [];
  let completed = false;
  const subscription = stream.subscribe({ next: (event) => events.push(event), complete: () => (completed = true) });
  return { events, completed: () => completed, subscription };
}

describe('liveTail', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("sends each line as it comes, as an event's data", async () => {
    const tail = source();
    const { events } = watch(liveTail(tail.lines, jest.fn()));

    tail.push(line('one'), line('two'));
    await jest.advanceTimersByTimeAsync(0);
    tail.push(line('three'));
    await jest.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ data: line('one') }, { data: line('two') }, { data: line('three') }]);
  });

  it('pings every 15 s while no line comes', async () => {
    const { events } = watch(liveTail(source().lines, jest.fn()));

    await jest.advanceTimersByTimeAsync(PING_MS - 1);
    expect(events).toEqual([]);
    await jest.advanceTimersByTimeAsync(PING_MS + 1);

    expect(events).toEqual([
      { type: 'ping', data: '' },
      { type: 'ping', data: '' },
    ]);
  });

  it('ends after 30 minutes with an end event, then nothing more', async () => {
    const tail = source();
    const { events, completed } = watch(liveTail(tail.lines, jest.fn()));

    await jest.advanceTimersByTimeAsync(LIVE_TAIL_MS - 1);
    expect([events.length, completed()]).toEqual([LIVE_TAIL_MS / PING_MS - 1, false]); // pings only, so far

    await jest.advanceTimersByTimeAsync(1);
    const atTheEnd = events.length;
    tail.push(line('too late'));
    await jest.advanceTimersByTimeAsync(PING_MS * 2);

    expect(events.at(-1)).toEqual({ type: 'end', data: { message: TAIL_ENDED } });
    expect(completed()).toBe(true);
    expect(events).toHaveLength(atTheEnd);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ends, with an end event, when the store ends the tail', async () => {
    const tail = source();
    const { events, completed } = watch(liveTail(tail.lines, jest.fn()));

    tail.push(line('last'));
    tail.end();
    await jest.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ data: line('last') }, { type: 'end', data: { message: TAIL_ENDED } }]);
    expect(completed()).toBe(true);
  });

  it('says unavailable when the store fails, and gives the cause to onFailure alone (D4)', async () => {
    const tail = source();
    const onFailure = jest.fn();
    const { events, completed } = watch(liveTail(tail.lines, onFailure));

    tail.push(line('before'), new Error('socket hang up at 10.42.0.7:9428'));
    await jest.advanceTimersByTimeAsync(0);

    expect(events).toEqual([{ data: line('before') }, { type: 'unavailable', data: { message: TAIL_UNAVAILABLE } }]);
    expect(JSON.stringify(events)).not.toContain('10.42.0.7');
    expect(onFailure).toHaveBeenCalledWith(new Error('socket hang up at 10.42.0.7:9428'));
    expect(completed()).toBe(true);
  });

  it('stops its timers when the client goes, and reports nothing of the tail stopping then', async () => {
    const tail = source();
    const onFailure = jest.fn();
    const { events, subscription } = watch(liveTail(tail.lines, onFailure));

    subscription.unsubscribe();
    tail.push(new Error('aborted: the request signal')); // the source stops when the request's signal aborts
    await jest.advanceTimersByTimeAsync(LIVE_TAIL_MS);

    expect(events).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

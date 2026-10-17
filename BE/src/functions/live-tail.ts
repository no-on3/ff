import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { FunctionLogLine } from '../orchestrator/orchestrator.types';

/** How long a live tail lasts: then it ends, and the client opens another (P-43). */
export const LIVE_TAIL_MS = 30 * 60_000;
/** A `ping` event this often keeps proxies from closing a quiet stream, and finds a client that went. */
export const PING_MS = 15_000;

export const TAIL_ENDED = 'The live tail lasts 30 minutes: open it again to go on.';
export const TAIL_UNAVAILABLE = 'Logs are unavailable right now. Try again in a minute.';

/**
 * A function's live tail as Server-Sent Events: each line as it comes, as the
 * event's data; `ping` every 15 s; `end` after 30 minutes, or when the store
 * ends the tail; `unavailable` when it fails, whose cause goes to `onFailure`
 * only (D4). The stream then ends. Its timers stop when the client goes; the
 * lines' source stops with the request's own signal.
 */
export function liveTail(
  lines: AsyncIterable<FunctionLogLine>,
  onFailure: (error: unknown) => void,
  timing = { lifetimeMs: LIVE_TAIL_MS, pingMs: PING_MS },
): Observable<MessageEvent> {
  return new Observable<MessageEvent>((subscriber) => {
    let open = true;
    const finish = (event: MessageEvent) => {
      if (!open) return;
      open = false;
      subscriber.next(event);
      subscriber.complete();
    };
    const ping = setInterval(() => open && subscriber.next({ type: 'ping', data: '' }), timing.pingMs);
    const lifetime = setTimeout(() => finish({ type: 'end', data: { message: TAIL_ENDED } }), timing.lifetimeMs);
    void (async () => {
      try {
        for await (const line of lines) {
          if (!open) return;
          subscriber.next({ data: line });
        }
        finish({ type: 'end', data: { message: TAIL_ENDED } });
      } catch (error) {
        if (!open) return; // the tail was stopped on purpose
        onFailure(error);
        finish({ type: 'unavailable', data: { message: TAIL_UNAVAILABLE } });
      }
    })();
    return () => {
      open = false;
      clearInterval(ping);
      clearTimeout(lifetime);
    };
  });
}

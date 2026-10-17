import type { MessageEvent } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { Observable, Subscription } from 'rxjs';

/** The most a client may leave unread before the stream drops it, so that a slow reader can't fill the backend's memory. */
export const MAX_UNREAD_BYTES = 8 * 1024 * 1024;

/**
 * Sends events as Server-Sent Events, once the route has made every check (P-43).
 * Nest's own @Sse() can't be used: with an interceptor, as the request ID's, it
 * commits its headers before an asynchronous handler is done, so a 404 found by
 * a database query would come as an event of a 200 stream. Ends when the events
 * complete; stops them, and calls `stop`, when the client goes or falls more
 * than MAX_UNREAD_BYTES behind.
 */
export function sendEvents(res: ServerResponse, events: Observable<MessageEvent>, stop: () => void): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    stop(); // the client went while the route was checking
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // Made first, so that finishing while the events are subscribed, as when they end at once, still stops them.
    const subscription = new Subscription();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      subscription.unsubscribe();
      stop();
      if (!res.writableEnded) res.end();
      resolve();
    };
    res.on('close', finish);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    let id = 0;
    subscription.add(
      events.subscribe({
        next: (event) => {
          res.write(format(event, ++id));
          if (res.writableLength > MAX_UNREAD_BYTES) finish();
        },
        complete: finish,
        error: finish,
      }),
    );
  });
}

/** One event: its type, if any, its number, and its data, a line of `data:` per line of it. */
export function format(event: MessageEvent, id: number): string {
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  const lines = data
    .split(/\r?\n/)
    .map((line) => `data: ${line}\n`)
    .join('');
  return `${event.type ? `event: ${event.type}\n` : ''}id: ${id}\n${lines}\n`;
}

/** L1 for the Server-Sent Events writer (P-43): the format, the end, a client that goes or doesn't read. */
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { Observable, Subject, of } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { MAX_UNREAD_BYTES, format, sendEvents } from './event-stream';

/** A response that keeps what is written, and whose client reads nothing unless told to. */
class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  head?: { status: number; headers: Record<string, string> };
  written = '';
  writeHead(status: number, headers: Record<string, string>) {
    this.head = { status, headers };
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.written += chunk;
    this.writableLength += Buffer.byteLength(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
}

const send = (res: FakeResponse, events: Observable<MessageEvent>, stop = jest.fn()) => ({
  done: sendEvents(res as unknown as ServerResponse, events, stop),
  stop,
});

describe('format', () => {
  it.each([
    [{ data: { message: 'hi' } }, 7, 'id: 7\ndata: {"message":"hi"}\n\n'],
    [{ type: 'ping', data: '' }, 8, 'event: ping\nid: 8\ndata: \n\n'],
    [{ data: 'one\ntwo\r\nthree' }, 9, 'id: 9\ndata: one\ndata: two\ndata: three\n\n'],
  ])('writes %j as event %d', (event, id, expected) => {
    expect(format(event as MessageEvent, id)).toBe(expected);
  });
});

describe('sendEvents', () => {
  it('sends the event-stream headers, then each event, numbered, and ends with the events', async () => {
    const res = new FakeResponse();

    const events: Observable<MessageEvent> = of({ data: { n: 1 } }, { type: 'ping', data: '' });
    const { done, stop } = send(res, events);
    await done;

    expect(res.head).toEqual({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' },
    });
    expect(res.written).toBe('id: 1\ndata: {"n":1}\n\nevent: ping\nid: 2\ndata: \n\n');
    expect([res.writableEnded, stop.mock.calls.length]).toEqual([true, 1]);
  });

  it('stops the events, and the tail, when the client goes', async () => {
    const res = new FakeResponse();
    const events = new Subject<MessageEvent>();

    const { done, stop } = send(res, events);
    events.next({ data: 'before' });
    res.emit('close');
    events.next({ data: 'after' });
    await done;

    expect(res.written).toBe('id: 1\ndata: before\n\n');
    expect(events.observed).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it(`drops a client that leaves more than ${MAX_UNREAD_BYTES / 1024 / 1024} MiB unread`, async () => {
    const res = new FakeResponse();
    const events = new Subject<MessageEvent>();
    const mebibyte = 'x'.repeat(1024 * 1024);

    const { done, stop } = send(res, events);
    for (let i = 0; i < 7; i++) events.next({ data: mebibyte });
    expect(stop).not.toHaveBeenCalled(); // 7 MiB and their framing
    events.next({ data: mebibyte }); // 8 MiB, and the framing past it
    await done;

    expect([events.observed, res.writableEnded, stop.mock.calls.length]).toEqual([false, true, 1]);
  });

  it("starts nothing for a client that went while the route was checking, but stops the tail", async () => {
    const res = new FakeResponse();
    res.destroyed = true;
    const events = new Subject<MessageEvent>();

    const { done, stop } = send(res, events);
    await done;

    expect([res.head, events.observed, stop.mock.calls.length]).toEqual([undefined, false, 1]);
  });
});

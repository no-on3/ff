import { describe, expect, it } from 'vitest';
import type { FunctionLogLine } from '../services/api';
import { LogStreamError } from '../services/api';
import { EventStreamParser, PAGE_LINES, filterFromSearch, lineTime, logsErrorMessage, mergeLines, pageQuery, searchForFilter } from './logs';

const line = (message: string, time = '2026-10-17T12:00:01.000000000Z', extra: Partial<FunctionLogLine> = {}): FunctionLogLine => ({
  time,
  instance: 'fn-a',
  requestId: null,
  stream: 'stdout',
  message,
  ...extra,
});

describe('the filter in the address (P-44)', () => {
  it('reads the defaults: the last hour, every line', () => {
    expect(filterFromSearch(new URLSearchParams('tab=logs'))).toEqual({ range: '1h', q: '', requestId: '' });
  });

  it('reads a range, a phrase and a call, and a range it does not know as the default', () => {
    expect(filterFromSearch(new URLSearchParams('range=7d&q=time+out&requestId=r-1'))).toEqual({ range: '7d', q: 'time out', requestId: 'r-1' });
    expect(filterFromSearch(new URLSearchParams('range=forever')).range).toBe('1h');
  });

  it('writes the logs tab and what is not a default, the phrase trimmed, and reads back what it wrote', () => {
    const written = searchForFilter({ range: 'all', q: '  time out ', requestId: 'r-1' });

    expect(written.toString()).toBe('tab=logs&range=all&q=time+out&requestId=r-1');
    expect(filterFromSearch(written)).toEqual({ range: 'all', q: 'time out', requestId: 'r-1' });
    expect(searchForFilter({ range: '1h', q: ' ', requestId: '' }).toString()).toBe('tab=logs');
  });
});

describe('pageQuery', () => {
  it('asks for a page of the range, in seconds, with the phrase and the call', () => {
    expect(pageQuery({ range: '15m', q: ' time out ', requestId: 'r-1' })).toEqual({ limit: PAGE_LINES, sinceSeconds: 900, q: 'time out', requestId: 'r-1' });
  });

  it("asks for all the plan keeps, with no window, and for the older lines with the cursor", () => {
    expect(pageQuery({ range: 'all', q: '', requestId: '' }, 'next-1')).toEqual({ limit: PAGE_LINES, cursor: 'next-1' });
  });
});

describe('EventStreamParser', () => {
  // What the API writes: numbered events, a ping with empty data.
  const stream = 'id: 1\ndata: {"message":"one"}\n\nevent: ping\nid: 2\ndata: \n\nevent: end\nid: 3\ndata: {"message":"over"}\n\n';
  const expected = [
    { type: 'message', data: '{"message":"one"}' },
    { type: 'ping', data: '' },
    { type: 'end', data: '{"message":"over"}' },
  ];

  it("reads the API's events", () => {
    expect(new EventStreamParser().push(stream)).toEqual(expected);
  });

  it('reads them cut at every point between two chunks, and a character at a time', () => {
    for (let cut = 1; cut < stream.length; cut++) {
      const parser = new EventStreamParser();
      expect([...parser.push(stream.slice(0, cut)), ...parser.push(stream.slice(cut))]).toEqual(expected);
    }
    const parser = new EventStreamParser();
    expect([...stream].flatMap((char) => parser.push(char))).toEqual(expected);
  });

  it('joins data lines, ends lines at CRLF too, skips comments and other fields, and gives no event without data', () => {
    expect(new EventStreamParser().push(': a comment\r\nretry: 10\r\ndata: one\r\ndata: two\r\n\r\nevent: lone\n\n')).toEqual([
      { type: 'message', data: 'one\ntwo' },
    ]);
  });
});

describe('mergeLines', () => {
  it('adds the lines that are new after the others, once each', () => {
    const page = [line('a', '2026-10-17T12:00:01Z'), line('b', '2026-10-17T12:00:02Z')];
    // The live tail starts a few seconds back: its first lines may be the page's last.
    const tail = [line('b', '2026-10-17T12:00:02Z'), line('c', '2026-10-17T12:00:03Z'), line('c', '2026-10-17T12:00:03Z')];

    expect(mergeLines(page, tail).map((l) => l.message)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a line of another instance, or stream, at the same time with the same text', () => {
    const merged = mergeLines([line('x')], [line('x', undefined, { instance: 'fn-b' }), line('x', undefined, { stream: 'stderr' })]);

    expect(merged).toHaveLength(3);
  });

  it('keeps the newest lines when there are more than the most it holds', () => {
    const merged = mergeLines([line('1'), line('2')], [line('3'), line('4')], 3);

    expect(merged.map((l) => l.message)).toEqual(['2', '3', '4']);
  });
});

describe('lineTime', () => {
  const now = new Date('2026-10-17T12:30:00Z');

  it("gives today's lines their time to the millisecond, in the browser's zone", () => {
    const at = '2026-10-17T12:00:01.123456789Z';
    expect(lineTime(at, now)).toBe(`${new Date(at).toLocaleTimeString(undefined, { hour12: false })}.123`);
  });

  it('gives an older line its day too', () => {
    const at = '2026-10-10T12:00:01.004Z';
    expect(lineTime(at, now)).toBe(`${new Date(at).toLocaleDateString()} ${new Date(at).toLocaleTimeString(undefined, { hour12: false })}.004`);
  });
});

describe('logsErrorMessage', () => {
  it('words 503, from a page or from the live tail, as the store being away for a moment', () => {
    const message = 'Logs are unavailable right now. Try again in a minute.';
    expect(logsErrorMessage({ response: { status: 503, data: { message: 'Service Unavailable' } } })).toBe(message);
    expect(logsErrorMessage(new LogStreamError(503, 'Service Unavailable'))).toBe(message);
  });

  it("gives the API's own message otherwise", () => {
    expect(logsErrorMessage({ response: { status: 400, data: { message: ['requestId must be a UUID'] } } })).toBe('requestId must be a UUID');
    expect(logsErrorMessage(new LogStreamError(404, 'Function with ID f-1 not found'))).toBe('Function with ID f-1 not found');
  });
});

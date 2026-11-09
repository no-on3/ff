/**
 * A function URL's event, as AWS Lambda's function URLs send it. The requests
 * and their events are function-url-examples.json's, which ff local's front
 * door reads too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UrlRequest, eventForHistory, requestTime, splitTarget, urlEvent } from './url-event';

/** A request as the table gives it: the base request's fields, the case's in their place. */
interface TableRequest {
  method?: string;
  target?: string;
  /** Each header as sent, a name and its value, in order. */
  headers?: Array<[string, string]>;
  /** The body as UTF-8 text, or its bytes in base64. */
  body?: string;
  bodyBase64?: string;
  sourceIp?: string;
  protocol?: string;
  domainName?: string;
  domainPrefix?: string;
  urlId?: string;
  requestId?: string;
  time?: string;
  accountId?: string;
  caller?: UrlRequest['caller'];
  withoutHeaders?: string[];
}

/** A case: a request, and its whole event, or what the event has, each part by its path, and what it lacks. */
interface EventExample {
  title: string;
  request: TableRequest;
  event?: Record<string, unknown>;
  has?: Record<string, unknown>;
  lacks?: string[];
}

const table = JSON.parse(readFileSync(join(__dirname, 'function-url-examples.json'), 'utf8')) as {
  request: TableRequest;
  events: Record<string, EventExample[]>;
};

/** The table's base request, the case's fields in its place, as the gateway gives urlEvent one. */
function requestOf(given: TableRequest): UrlRequest {
  const { headers, body, bodyBase64, time, ...rest } = { ...table.request, ...given };
  return {
    ...(rest as Omit<UrlRequest, 'rawHeaders' | 'body' | 'time'>),
    rawHeaders: (headers ?? []).flat(),
    body: bodyBase64 !== undefined && !('body' in given) ? Buffer.from(bodyBase64, 'base64') : Buffer.from(body ?? '', 'utf8'),
    time: new Date(time as string),
  };
}

/** The case's request's event is as it says: whole, or each part it names, and without what it lacks. */
function eventIsAsItSays(example: EventExample): void {
  const event = urlEvent(requestOf(example.request));
  if (example.event) expect(event).toEqual(example.event);
  for (const [path, value] of Object.entries(example.has ?? {})) expect(event).toHaveProperty(path.split('.'), value);
  for (const key of example.lacks ?? []) expect(event).not.toHaveProperty(key);
}

describe("a function URL's event", () => {
  it("has the shape of AWS's own example: payload format 2.0", () => {
    table.events.awsExample.forEach(eventIsAsItSays);
  });

  it('leaves out the query, the cookies and the body when the request has none, and keeps the root path', () => {
    table.events.empty.forEach(eventIsAsItSays);
  });

  it('decodes the query, and keeps the raw string as sent', () => {
    table.events.query.forEach(eventIsAsItSays);
  });

  it.each(table.events.text)('passes a $title body as text', eventIsAsItSays);

  it.each(table.events.base64)('passes $title in base64, saying so', eventIsAsItSays);

  it('lowercases header names, joins repeated ones, and never passes on per-connection ones nor the credentials it used', () => {
    table.events.headers.forEach(eventIsAsItSays);
  });

  it("names its caller when the URL takes the account's credentials", () => {
    table.events.caller.forEach(eventIsAsItSays);
  });

  it("keeps none of its callers' credentials in the history: no cookie, and *** for a credential's value", () => {
    const event = urlEvent(requestOf({ headers: [['authorization', 'Bearer secret-token'], ['x-api-key', 'k'], ['cookie', 'session=abc'], ['accept', 'text/html']] }));

    const kept = eventForHistory(event);

    expect(kept.headers).toEqual({ authorization: '***', 'x-api-key': '***', accept: 'text/html' });
    expect(kept).not.toHaveProperty('cookies');
    expect(JSON.stringify(kept)).not.toMatch(/secret-token|session=abc/);
    expect(event.cookies).toEqual(['session=abc']); // the function itself gets them
  });

  it('writes the time as API Gateway does, in UTC', () => {
    expect(requestTime(new Date('2026-01-05T03:04:05.678Z'))).toBe('05/Jan/2026:03:04:05 +0000');
  });

  it('splits a target into its path and query', () => {
    expect(splitTarget('/a/b?x=1?y')).toEqual({ rawPath: '/a/b', rawQueryString: 'x=1?y' });
    expect(splitTarget('?x=1')).toEqual({ rawPath: '/', rawQueryString: 'x=1' });
  });
});

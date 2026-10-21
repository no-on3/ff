import { UrlRequest, eventForHistory, requestTime, splitTarget, urlEvent } from './url-event';

/** The request behind AWS's own example of a function URL's event (its documentation, "Request payload format"). */
const awsExample: UrlRequest = {
  method: 'POST',
  target: '/my/path?parameter1=value1&parameter1=value2&parameter2=value',
  rawHeaders: ['header1', 'value1', 'header2', 'value1', 'header2', 'value2', 'Cookie', 'cookie1; cookie2', 'User-Agent', 'agent', 'Content-Type', 'text/plain'],
  body: Buffer.from('Hello from client!'),
  sourceIp: '123.123.123.123',
  protocol: 'HTTP/1.1',
  domainName: '0123456789abcdefghijklmnopqrstuv.fn.example.tn',
  domainPrefix: '0123456789abcdefghijklmnopqrstuv',
  urlId: '0123456789abcdefghijklmnopqrstuv',
  requestId: 'e1506fd5-9e7b-434f-bd42-4f8fa224b599',
  time: new Date('2020-03-12T19:03:58.390Z'),
  accountId: 'anonymous',
};

describe("a function URL's event", () => {
  it("has the shape of AWS's own example: payload format 2.0", () => {
    expect(urlEvent(awsExample)).toEqual({
      version: '2.0',
      routeKey: '$default',
      rawPath: '/my/path',
      rawQueryString: 'parameter1=value1&parameter1=value2&parameter2=value',
      cookies: ['cookie1', 'cookie2'],
      headers: { header1: 'value1', header2: 'value1,value2', 'user-agent': 'agent', 'content-type': 'text/plain' },
      queryStringParameters: { parameter1: 'value1,value2', parameter2: 'value' },
      requestContext: {
        accountId: 'anonymous',
        apiId: '0123456789abcdefghijklmnopqrstuv',
        authentication: null,
        domainName: '0123456789abcdefghijklmnopqrstuv.fn.example.tn',
        domainPrefix: '0123456789abcdefghijklmnopqrstuv',
        http: { method: 'POST', path: '/my/path', protocol: 'HTTP/1.1', sourceIp: '123.123.123.123', userAgent: 'agent' },
        requestId: 'e1506fd5-9e7b-434f-bd42-4f8fa224b599',
        routeKey: '$default',
        stage: '$default',
        time: '12/Mar/2020:19:03:58 +0000',
        timeEpoch: 1584039838390,
      },
      body: 'Hello from client!',
      isBase64Encoded: false,
    });
  });

  it('leaves out the query, the cookies and the body when the request has none, and keeps the root path', () => {
    const event = urlEvent({ ...awsExample, method: 'GET', target: '/', rawHeaders: [], body: Buffer.alloc(0) });

    expect(event).not.toHaveProperty('queryStringParameters');
    expect(event).not.toHaveProperty('cookies');
    expect(event).not.toHaveProperty('body');
    expect(event).toMatchObject({ rawPath: '/', rawQueryString: '', isBase64Encoded: false, headers: {} });
    expect(event.requestContext.http.userAgent).toBe('');
  });

  it('decodes the query, and keeps the raw string as sent', () => {
    const event = urlEvent({ ...awsExample, target: '/search?q=caf%C3%A9+au+lait&empty=&flag' });

    expect(event.rawQueryString).toBe('q=caf%C3%A9+au+lait&empty=&flag');
    expect(event.queryStringParameters).toEqual({ q: 'café au lait', empty: '', flag: '' });
  });

  it.each([
    ['application/json', '{"a":1}'],
    ['application/json; charset=utf-8', '{"city":"تونس"}'],
    ['text/html', '<p>é</p>'],
    ['application/xml', '<a/>'],
    ['application/vnd.api+json', '{}'],
  ])('passes a %s body as text', (type, text) => {
    const event = urlEvent({ ...awsExample, rawHeaders: ['content-type', type], body: Buffer.from(text) });

    expect([event.body, event.isBase64Encoded]).toEqual([text, false]);
  });

  it.each([
    ['an image', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])],
    ['a form, which AWS sends in base64 too', 'application/x-www-form-urlencoded', Buffer.from('a=1&b=2')],
    ['no type at all', undefined, Buffer.from('raw bytes')],
    ['text that is not UTF-8', 'text/plain', Buffer.from([0xff, 0xfe, 0x41])],
  ])('passes %s in base64, saying so', (_case, type, bytes) => {
    const event = urlEvent({ ...awsExample, rawHeaders: type ? ['content-type', type] : [], body: bytes });

    expect(event.isBase64Encoded).toBe(true);
    expect(Buffer.from(event.body!, 'base64').equals(bytes)).toBe(true);
  });

  it('lowercases header names, joins repeated ones, and never passes on per-connection ones nor the credentials it used', () => {
    const event = urlEvent({
      ...awsExample,
      rawHeaders: ['X-Trace', 'a', 'x-trace', 'b', 'Connection', 'keep-alive', 'Transfer-Encoding', 'chunked', 'Authorization', 'Bearer ffk_x', 'Host', 'h'],
      withoutHeaders: ['authorization'],
    });

    expect(event.headers).toEqual({ 'x-trace': 'a,b', host: 'h' });
  });

  it('names its caller when the URL takes the account\'s credentials', () => {
    const event = urlEvent({ ...awsExample, accountId: '123456789012', caller: { accessKey: 'a1b2c3', accountId: '123456789012', userId: 'u-1' } });

    expect(event.requestContext.accountId).toBe('123456789012');
    expect(event.requestContext.authorizer).toEqual({
      iam: { accessKey: 'a1b2c3', accountId: '123456789012', callerId: 'u-1', cognitoIdentity: null, principalOrgId: null, userArn: null, userId: 'u-1' },
    });
  });

  it("keeps none of its callers' credentials in the history: no cookie, and *** for a credential's value", () => {
    const event = urlEvent({ ...awsExample, rawHeaders: ['authorization', 'Bearer secret-token', 'x-api-key', 'k', 'cookie', 'session=abc', 'accept', 'text/html'] });

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

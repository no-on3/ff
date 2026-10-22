import { InvalidUrlResponseError, urlAnswer } from './url-response';

const text = (answer: { body: Buffer }) => answer.body.toString('utf8');

describe("what a function's return value answers its URL's caller", () => {
  it.each([
    ['a string, in quotes, as Lambda\'s documentation shows', 'Hello, world!', '"Hello, world!"'],
    ['an object without statusCode, as its JSON', { message: 'Hello, world!' }, '{"message":"Hello, world!"}'],
    ['a number', 42, '42'],
    ['null', null, 'null'],
    ['an array', [1, 2], '[1,2]'],
  ])('answers 200 with JSON for %s', (_case, output, body) => {
    const answer = urlAnswer(output);

    expect(answer.status).toBe(200);
    expect(answer.headers).toEqual([['content-type', 'application/json']]);
    expect(text(answer)).toBe(body);
  });

  it('answers a response as it says: status, headers, body', () => {
    const answer = urlAnswer({ statusCode: 201, headers: { 'Content-Type': 'text/plain', 'My-Custom-Header': 'Custom Value' }, body: 'made' });

    expect(answer).toEqual({
      status: 201,
      headers: [
        ['Content-Type', 'text/plain'],
        ['My-Custom-Header', 'Custom Value'],
      ],
      body: Buffer.from('made'),
    });
  });

  it("says JSON when the response names no type, as Lambda's does", () => {
    expect(urlAnswer({ statusCode: 204 }).headers).toEqual([['content-type', 'application/json']]);
    expect(text(urlAnswer({ statusCode: 204 }))).toBe('');
  });

  it('turns each cookie into a Set-Cookie header', () => {
    const answer = urlAnswer({ statusCode: 200, cookies: ['a=1; Max-Age=60', 'b=2'], body: '' });

    expect(answer.headers.filter(([name]) => name === 'set-cookie')).toEqual([
      ['set-cookie', 'a=1; Max-Age=60'],
      ['set-cookie', 'b=2'],
    ]);
  });

  it('decodes a base64 body, for images and other bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const answer = urlAnswer({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: png.toString('base64'), isBase64Encoded: true });

    expect(answer.body.equals(png)).toBe(true);
  });

  it("sends a body that isn't text as its JSON, numbers and booleans as headers' text", () => {
    const answer = urlAnswer({ statusCode: '202', headers: { 'X-Count': 3, 'X-Flag': true, 'X-None': null }, body: { ok: true } });

    expect(answer.status).toBe(202);
    expect(answer.headers).toEqual([
      ['X-Count', '3'],
      ['X-Flag', 'true'],
      ['content-type', 'application/json'],
    ]);
    expect(text(answer)).toBe('{"ok":true}');
  });

  it('drops the headers the server sets itself: per connection, and the length', () => {
    const answer = urlAnswer({ statusCode: 200, headers: { 'Content-Length': '999', Connection: 'close', 'Transfer-Encoding': 'chunked', 'X-Kept': 'yes' }, body: 'ok' });

    expect(answer.headers).toEqual([
      ['X-Kept', 'yes'],
      ['content-type', 'application/json'],
    ]);
  });

  it.each([
    ['a status out of range', { statusCode: 600 }, 'statusCode must be a whole number from 200 to 599; got 600'],
    ['an interim status, which ends no request', { statusCode: 101 }, 'statusCode must be a whole number from 200 to 599; got 101'],
    ['a status that is no number', { statusCode: 'OK' }, 'statusCode must be a whole number from 200 to 599; got "OK"'],
    ['headers that are no object', { statusCode: 200, headers: ['x'] }, 'headers must be an object of names to values'],
    ['a header name with a space', { statusCode: 200, headers: { 'bad name': 'x' } }, '"bad name" is not a header name'],
    ['a header value with a line break', { statusCode: 200, headers: { 'X-A': 'a\r\nSet-Cookie: x=1' } }, "the header X-A's value holds a line break or NUL"],
    ['an object as a header value', { statusCode: 200, headers: { 'X-A': { b: 1 } } }, "the header X-A's value must be a string, a number or a boolean"],
    ['cookies that are no list of strings', { statusCode: 200, cookies: 'a=1' }, 'cookies must be a list of strings'],
  ])('refuses %s, which the caller gets as 502', (_case, output, reason) => {
    expect(() => urlAnswer(output)).toThrow(new InvalidUrlResponseError(reason));
  });
});

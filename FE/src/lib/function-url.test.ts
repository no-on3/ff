import { describe, expect, it } from 'vitest';
import { CorsForm, authTypeText, corsFormOf, corsOf, corsText, curlExample, listOf } from './function-url';

const form = (fields: Partial<CorsForm> = {}): CorsForm => ({ ...corsFormOf(null), enabled: true, ...fields });

describe("a function URL's CORS, as the form types it", () => {
  it('reads lists on lines or between commas, without the empty items', () => {
    expect(listOf('https://a.example.tn\n https://b.example.tn, ,\n')).toEqual(['https://a.example.tn', 'https://b.example.tn']);
  });

  it("gives the API AWS Lambda's fields, only those filled in", () => {
    expect(
      corsOf(
        form({
          allowOrigins: 'https://app.example.tn\nhttp://localhost:5173',
          allowMethods: ['GET', 'POST'],
          allowHeaders: 'content-type, x-request-id',
          exposeHeaders: 'x-total-count',
          allowCredentials: true,
          maxAge: '600',
        }),
      ),
    ).toEqual({
      cors: {
        allowOrigins: ['https://app.example.tn', 'http://localhost:5173'],
        allowMethods: ['GET', 'POST'],
        allowHeaders: ['content-type', 'x-request-id'],
        exposeHeaders: ['x-total-count'],
        allowCredentials: true,
        maxAge: 600,
      },
    });
    expect(corsOf(form())).toEqual({ cors: {} });
  });

  it('sends null without CORS, and "*" alone when every method is allowed', () => {
    expect(corsOf(form({ enabled: false, allowOrigins: 'https://ignored.example' }))).toEqual({ cors: null });
    expect(corsOf(form({ allowMethods: ['GET', 'PUT', 'HEAD', 'POST', 'PATCH', 'DELETE', '*'] }))).toEqual({ cors: { allowMethods: ['*'] } });
  });

  it.each([
    ['an origin with a path', { allowOrigins: 'https://app.example.tn/' }, 'Allowed origins: "https://app.example.tn/" is not an origin, such as https://www.example.tn, or *'],
    ['an origin without a scheme', { allowOrigins: 'app.example.tn' }, 'Allowed origins: "app.example.tn" is not an origin, such as https://www.example.tn, or *'],
    ['a header with a space', { allowHeaders: 'x request' }, 'Allowed headers: "x request" is not a header name, or *'],
    ['an exposed header with a colon', { exposeHeaders: 'x-total:' }, 'Exposed headers: "x-total:" is not a header name'],
    ['a max age over a day', { maxAge: '86401' }, 'Max age: a whole number of seconds, 86400 (a day) at most'],
    ['a max age that is no number', { maxAge: '10m' }, 'Max age: a whole number of seconds, 86400 (a day) at most'],
  ])('says what is wrong: %s', (_case, fields, problem) => {
    expect(corsOf(form(fields))).toEqual({ problem });
  });

  it('fills the form from a configuration, and back to the same one', () => {
    const cors = { allowOrigins: ['https://app.example.tn'], allowMethods: ['GET'], allowHeaders: ['content-type'], maxAge: 0 };

    expect(corsOf(corsFormOf(cors))).toEqual({ cors });
    expect(corsFormOf(null)).toMatchObject({ enabled: false, allowOrigins: '', allowMethods: [], maxAge: '' });
  });
});

describe('a function URL, to read', () => {
  const address = 'https://0123456789abcdefghijklmnopqrstuv.fn.example.tn/';

  it('says who may call it, and how', () => {
    expect([authTypeText('NONE'), curlExample({ functionUrl: address, authType: 'NONE' })]).toEqual(['Anyone may call it.', `curl ${address}`]);
    expect([authTypeText('AWS_IAM'), curlExample({ functionUrl: address, authType: 'AWS_IAM' })]).toEqual([
      'Only callers with an API key of this account that has functions:invoke.',
      `curl -H 'Authorization: Bearer ffk_…' ${address}`,
    ]);
  });

  it('says which browsers may call it', () => {
    expect(corsText(null)).toBe("No CORS: your function answers browsers' preflights itself, as any request.");
    expect(corsText({})).toBe("CORS allows no origin: browsers on other sites can't read its answers.");
    expect(corsText({ allowOrigins: ['*'] })).toBe('Browsers on any site may call it.');
    expect(corsText({ allowOrigins: ['https://a.example.tn', 'https://b.example.tn'], allowCredentials: true })).toBe(
      'Browsers on https://a.example.tn, https://b.example.tn may call it, with their cookies.',
    );
  });
});

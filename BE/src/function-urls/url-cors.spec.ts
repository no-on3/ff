import { allowsOrigin, isCorsHeader, isPreflight, preflightHeaders, responseCorsHeaders } from './url-cors';

describe("a function URL's CORS", () => {
  const cors = {
    allowOrigins: ['https://app.example.tn'],
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['content-type', 'x-request'],
    exposeHeaders: ['x-total'],
    maxAge: 600,
  };

  it("knows a browser's preflight: OPTIONS, an origin, a method asked for", () => {
    expect(isPreflight('OPTIONS', { origin: 'https://a', 'access-control-request-method': 'POST' })).toBe(true);
    expect(isPreflight('OPTIONS', { origin: 'https://a' })).toBe(false);
    expect(isPreflight('GET', { origin: 'https://a', 'access-control-request-method': 'POST' })).toBe(false);
  });

  it('lets in the origins it names, compared without case, or any with "*"', () => {
    expect(allowsOrigin(cors, 'https://APP.example.tn')).toBe(true);
    expect(allowsOrigin(cors, 'https://evil.example')).toBe(false);
    expect(allowsOrigin(cors, undefined)).toBe(false);
    expect(allowsOrigin({ allowOrigins: ['*'] }, 'https://anyone.example')).toBe(true);
  });

  it("answers an allowed origin's preflight with the configuration, the origin echoed", () => {
    expect(preflightHeaders(cors, 'https://app.example.tn')).toEqual([
      ['access-control-allow-origin', 'https://app.example.tn'],
      ['vary', 'Origin'],
      ['access-control-allow-methods', 'GET,POST'],
      ['access-control-allow-headers', 'content-type,x-request'],
      ['access-control-max-age', '600'],
    ]);
  });

  it("answers another origin's preflight with nothing, which the browser refuses", () => {
    expect(preflightHeaders(cors, 'https://evil.example')).toEqual([]);
  });

  it('says "*" to any origin without credentials, and echoes the origin with them, as browsers require', () => {
    expect(responseCorsHeaders({ allowOrigins: ['*'] }, 'https://a.example')).toEqual([['access-control-allow-origin', '*']]);
    expect(responseCorsHeaders({ allowOrigins: ['*'], allowCredentials: true }, 'https://a.example')).toEqual([
      ['access-control-allow-origin', 'https://a.example'],
      ['vary', 'Origin'],
      ['access-control-allow-credentials', 'true'],
    ]);
  });

  it("adds to an allowed origin's answers the origin and the headers it may read", () => {
    expect(responseCorsHeaders(cors, 'https://app.example.tn')).toEqual([
      ['access-control-allow-origin', 'https://app.example.tn'],
      ['vary', 'Origin'],
      ['access-control-expose-headers', 'x-total'],
    ]);
    expect(responseCorsHeaders(cors, 'https://evil.example')).toEqual([]);
  });

  it("knows the function's own CORS headers, which the configuration replaces", () => {
    expect(isCorsHeader('Access-Control-Allow-Origin')).toBe(true);
    expect(isCorsHeader('content-type')).toBe(false);
  });
});

/**
 * A request to a function URL as its function gets it: API Gateway's payload
 * format 2.0, which AWS Lambda's function URLs send, so that a handler written
 * for one runs on the other unchanged.
 */

/** What the gateway knows of a request, to build its event. */
export interface UrlRequest {
  method: string;
  /** The path and query string, as the request line has them. */
  target: string;
  /** The request's header lines in order, as Node's rawHeaders gives them: a name, its value, the next name… */
  rawHeaders: string[];
  body: Buffer;
  sourceIp: string;
  /** HTTP/1.1, or what the client spoke. */
  protocol: string;
  /** The host the request named, without its port. */
  domainName: string;
  /** The function URL's ID: the host's first label, or the custom domain's. */
  domainPrefix: string;
  urlId: string;
  /** The invocation's ID, which the function also gets as its context's request ID. */
  requestId: string;
  time: Date;
  /** `anonymous` for a URL anyone may call; the function's account for one that takes the account's credentials. */
  accountId: string;
  /** Who called a URL that takes the account's credentials. */
  caller?: { accessKey: string; accountId: string; userId: string };
  /** Headers not passed on, by lower-case name: the credentials that authenticated the call. */
  withoutHeaders?: string[];
}

export interface FunctionUrlEvent {
  version: '2.0';
  routeKey: '$default';
  rawPath: string;
  rawQueryString: string;
  cookies?: string[];
  headers: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  requestContext: {
    accountId: string;
    apiId: string;
    authentication: null;
    authorizer?: { iam: { accessKey: string; accountId: string; callerId: string; cognitoIdentity: null; principalOrgId: null; userArn: null; userId: string } };
    domainName: string;
    domainPrefix: string;
    http: { method: string; path: string; protocol: string; sourceIp: string; userAgent: string };
    requestId: string;
    routeKey: '$default';
    stage: '$default';
    time: string;
    timeEpoch: number;
  };
  body?: string;
  isBase64Encoded: boolean;
}

/** Headers that belong to one connection, never passed on (RFC 9110, §7.6.1). */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** The body is text when its type says text, JSON or XML, and it is valid UTF-8; anything else is base64, as LocalStack emulates AWS. */
const TEXT_TYPE = /text|json|xml/i;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** API Gateway's request time: 12/Mar/2020:19:03:58 +0000, in UTC. */
export function requestTime(time: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${two(time.getUTCDate())}/${MONTHS[time.getUTCMonth()]}/${time.getUTCFullYear()}:` +
    `${two(time.getUTCHours())}:${two(time.getUTCMinutes())}:${two(time.getUTCSeconds())} +0000`
  );
}

/** The path and the query string of a request target: the query without its "?", "" when there is none. */
export function splitTarget(target: string): { rawPath: string; rawQueryString: string } {
  const at = target.indexOf('?');
  const path = at === -1 ? target : target.slice(0, at);
  return { rawPath: path === '' ? '/' : path, rawQueryString: at === -1 ? '' : target.slice(at + 1) };
}

/** The body as the event holds it: text when it is, else base64; none when empty. */
function eventBody(body: Buffer, contentType: string | undefined): { body?: string; isBase64Encoded: boolean } {
  if (body.length === 0) return { isBase64Encoded: false };
  if (contentType && TEXT_TYPE.test(contentType)) {
    try {
      return { body: strictUtf8.decode(body), isBase64Encoded: false };
    } catch {
      // not UTF-8 after all: base64, below
    }
  }
  return { body: body.toString('base64'), isBase64Encoded: true };
}

/** The event a function URL's request becomes. */
export function urlEvent(request: UrlRequest): FunctionUrlEvent {
  const { rawPath, rawQueryString } = splitTarget(request.target);
  const skipped = new Set(request.withoutHeaders ?? []);
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (let i = 0; i + 1 < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    const value = request.rawHeaders[i + 1];
    if (name === 'cookie') {
      cookies.push(...value.split(';').map((cookie) => cookie.trim()).filter(Boolean));
    } else if (!HOP_BY_HOP.has(name) && !skipped.has(name)) {
      // Repeated headers are joined with commas, as API Gateway's payload 2.0 does.
      headers[name] = name in headers ? `${headers[name]},${value}` : value;
    }
  }
  const query: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(rawQueryString)) query[name] = name in query ? `${query[name]},${value}` : value;
  const { caller } = request;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString,
    ...(cookies.length > 0 ? { cookies } : {}),
    headers,
    ...(rawQueryString !== '' ? { queryStringParameters: query } : {}),
    requestContext: {
      accountId: request.accountId,
      apiId: request.urlId,
      authentication: null,
      ...(caller
        ? {
            authorizer: {
              iam: {
                accessKey: caller.accessKey,
                accountId: caller.accountId,
                callerId: caller.userId,
                cognitoIdentity: null,
                principalOrgId: null,
                userArn: null,
                userId: caller.userId,
              },
            },
          }
        : {}),
      domainName: request.domainName,
      domainPrefix: request.domainPrefix,
      http: {
        method: request.method,
        path: rawPath,
        protocol: request.protocol,
        sourceIp: request.sourceIp,
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: request.requestId,
      routeKey: '$default',
      stage: '$default',
      time: requestTime(request.time),
      timeEpoch: request.time.getTime(),
    },
    ...eventBody(request.body, headers['content-type']),
  };
}

/** Header values the history never keeps: the function's callers' credentials. */
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'x-api-key'];

/**
 * What the invocation history keeps of a function URL's event: everything but
 * the callers' credentials, whose values become *** and whose cookies go.
 */
export function eventForHistory(event: FunctionUrlEvent): FunctionUrlEvent {
  const headers = Object.fromEntries(Object.entries(event.headers).map(([name, value]) => [name, CREDENTIAL_HEADERS.includes(name) ? '***' : value]));
  const kept: FunctionUrlEvent = { ...event, headers };
  delete kept.cookies;
  return kept;
}

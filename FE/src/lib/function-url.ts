/**
 * A function's URL, as the console shows and edits it: AWS Lambda's function
 * URL configuration, and its CORS fields as the form types them (a list in
 * one box, one item a line or separated by commas). The rules are the API's,
 * so the form says what is wrong before anything is sent; contract.test.ts
 * ties them to the API's.
 */

/** Who may call a URL: anyone, or callers with the account's credentials (on FF, an API key with functions:invoke). */
export const AUTH_TYPES = ['NONE', 'AWS_IAM'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

/** The methods a URL's CORS may allow, as the API takes them; "*" is any. */
export const CORS_METHODS = ['GET', 'PUT', 'HEAD', 'POST', 'PATCH', 'DELETE', '*'] as const;

/** An origin as a browser sends it, or "*": the API's rule. */
export const ORIGIN = /^(\*|[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)$/i;
/** A header's name, as HTTP defines a token; "*" is one. The API's rule. */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** The API's limits on CORS, which are AWS Lambda's. */
export const CORS_LIMITS = { origins: 100, originLength: 253, headers: 100, headerLength: 1024, methods: 6, maxAge: 86400 } as const;

/** A URL's CORS, as AWS Lambda's Cors, in camelCase. */
export interface UrlCors {
  allowCredentials?: boolean;
  allowHeaders?: string[];
  allowMethods?: string[];
  allowOrigins?: string[];
  exposeHeaders?: string[];
  maxAge?: number;
}

/** The fields of a function's URL as the API answers them: contract.test.ts checks them against its view. */
export const FUNCTION_URL_FIELDS = ['functionUrl', 'functionId', 'authType', 'cors', 'invokeMode', 'createdAt', 'updatedAt'] as const;

/** A function's URL, as the API answers it. */
export interface FunctionUrl {
  /** Its address, fixed for its life: https://<32 letters and digits>.<the function domain>/. */
  functionUrl: string;
  functionId: string;
  authType: AuthType;
  cors: UrlCors | null;
  /** BUFFERED: the answer is sent whole, once the function returns. */
  invokeMode: 'BUFFERED';
  createdAt: string;
  updatedAt: string;
}

/** The form's CORS fields, as typed. */
export interface CorsForm {
  /** Whether the URL has a CORS configuration at all. */
  enabled: boolean;
  allowOrigins: string;
  allowMethods: string[];
  allowHeaders: string;
  exposeHeaders: string;
  allowCredentials: boolean;
  /** Seconds, or empty for the browser's own default. */
  maxAge: string;
}

/** The form for a URL's CORS: empty, or filled from the URL's configuration. */
export function corsFormOf(cors: UrlCors | null): CorsForm {
  return {
    enabled: cors !== null,
    allowOrigins: (cors?.allowOrigins ?? []).join('\n'),
    allowMethods: cors?.allowMethods ?? [],
    allowHeaders: (cors?.allowHeaders ?? []).join(', '),
    exposeHeaders: (cors?.exposeHeaders ?? []).join(', '),
    allowCredentials: cors?.allowCredentials ?? false,
    maxAge: cors?.maxAge === undefined ? '' : String(cors.maxAge),
  };
}

/** A list as typed: items on lines or between commas, trimmed, without empty ones. */
export const listOf = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');

function listProblem(name: string, items: string[], rule: RegExp, most: number, longest: number, what: string): string | null {
  if (items.length > most) return `${name}: ${most} at most`;
  const bad = items.find((item) => item.length > longest || !rule.test(item));
  return bad === undefined ? null : `${name}: "${bad}" is not ${what}`;
}

/**
 * The CORS configuration the form says, as the API takes it, or what is wrong
 * with it. A configuration without any field is one: it allows no origin.
 */
export function corsOf(form: CorsForm): { cors: UrlCors | null } | { problem: string } {
  if (!form.enabled) return { cors: null };
  const allowOrigins = listOf(form.allowOrigins);
  const allowHeaders = listOf(form.allowHeaders);
  const exposeHeaders = listOf(form.exposeHeaders);
  const problem =
    listProblem('Allowed origins', allowOrigins, ORIGIN, CORS_LIMITS.origins, CORS_LIMITS.originLength, 'an origin, such as https://www.example.tn, or *') ??
    listProblem('Allowed headers', allowHeaders, HEADER_NAME, CORS_LIMITS.headers, CORS_LIMITS.headerLength, 'a header name, or *') ??
    listProblem('Exposed headers', exposeHeaders, HEADER_NAME, CORS_LIMITS.headers, CORS_LIMITS.headerLength, 'a header name');
  if (problem) return { problem };
  const maxAge = form.maxAge.trim();
  if (maxAge !== '' && (!/^\d+$/.test(maxAge) || Number(maxAge) > CORS_LIMITS.maxAge)) {
    return { problem: `Max age: a whole number of seconds, ${CORS_LIMITS.maxAge} (a day) at most` };
  }
  return {
    cors: {
      ...(allowOrigins.length ? { allowOrigins } : {}),
      // "*" says them all: with it, the others would only pass the API's limit of six.
      ...(form.allowMethods.length ? { allowMethods: form.allowMethods.includes('*') ? ['*'] : form.allowMethods } : {}),
      ...(allowHeaders.length ? { allowHeaders } : {}),
      ...(exposeHeaders.length ? { exposeHeaders } : {}),
      ...(form.allowCredentials ? { allowCredentials: true } : {}),
      ...(maxAge !== '' ? { maxAge: Number(maxAge) } : {}),
    },
  };
}

/** Who may call a URL, in a sentence. */
export const authTypeText = (authType: AuthType): string =>
  authType === 'NONE' ? 'Anyone may call it.' : 'Only callers with an API key of this account that has functions:invoke.';

/** A URL's CORS, in a sentence. */
export function corsText(cors: UrlCors | null): string {
  if (cors === null) return 'No CORS: your function answers browsers\' preflights itself, as any request.';
  const origins = cors.allowOrigins ?? [];
  if (origins.length === 0) return 'CORS allows no origin: browsers on other sites can\'t read its answers.';
  return `Browsers on ${origins.includes('*') ? 'any site' : origins.join(', ')} may call it${cors.allowCredentials ? ', with their cookies' : ''}.`;
}

/** How to call a URL with curl, with the key it needs. */
export const curlExample = (url: Pick<FunctionUrl, 'functionUrl' | 'authType'>): string =>
  url.authType === 'NONE' ? `curl ${url.functionUrl}` : `curl -H 'Authorization: Bearer ffk_…' ${url.functionUrl}`;

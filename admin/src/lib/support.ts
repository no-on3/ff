import type { AccountSummary } from './accounts';

/**
 * Support: finding what a customer asks about, and a function's page. What
 * the customer's users sent and got back, the code and the logs come only for
 * a reason, which the account's audit log keeps: its owners see each look,
 * as FF's. contract.test.ts checks these fields against the API's.
 */

export const FUNCTION_HIT_FIELDS = ['id', 'name', 'runtime', 'status', 'accountId', 'accountName'] as const;
export type FunctionHit = Record<(typeof FUNCTION_HIT_FIELDS)[number], string>;

export const CALL_HIT_FIELDS = ['requestId', 'functionId', 'functionName', 'accountId', 'status', 'at', 'inHistory', 'functionExists'] as const;
export interface CallHit {
  requestId: string;
  functionId: string;
  /** Its name when it was called. */
  functionName: string;
  accountId: string;
  status: string;
  at: string;
  /** Whether the invocation history still has the call; if not, its usage record was found. */
  inHistory: boolean;
  functionExists: boolean;
}

export interface SearchResults {
  accounts: AccountSummary[];
  functions: FunctionHit[];
  calls: CallHit[];
}

export const CALL_FIELDS = ['id', 'status', 'source', 'duration', 'memoryUsed', 'createdAt', 'errorType'] as const;
/** What brought a call: the API, the function's URL, or a schedule. */
export type CallSource = 'api' | 'url' | 'schedule';
/** A call, without what went in or out. */
export interface Call {
  id: string;
  status: string;
  source: CallSource;
  /** Milliseconds. */
  duration: number;
  memoryUsed: number | null;
  createdAt: string;
  /** A failed call's error type, without its message. */
  errorType: string | null;
}

export const DOMAIN_FIELDS = ['domain', 'status', 'checkError'] as const;
/** A customer's own domain for a URL, and where it stands. */
export interface Domain {
  domain: string;
  status: 'pending' | 'verified';
  /** What its last check found wrong. */
  checkError: string | null;
}

export const FUNCTION_URL_FIELDS = ['functionUrl', 'authType', 'cors', 'createdAt', 'domains'] as const;
/** A function's URL: its address, who may call it, and the customer's own domains for it. */
export interface FunctionUrl {
  functionUrl: string;
  /** NONE: anyone; AWS_IAM: an API key of the account. */
  authType: 'NONE' | 'AWS_IAM';
  /** Whether it has a CORS configuration. */
  cors: boolean;
  createdAt: string;
  domains: Domain[];
}

export const FUNCTION_PAGE_FIELDS = ['function', 'url', 'variables', 'secrets', 'account', 'recentCalls', 'recentErrors'] as const;
export interface FunctionPage {
  function: {
    id: string;
    name: string;
    runtime: string;
    memory: number;
    timeout: number;
    minInstances: number;
    maxInstances: number;
    status: string;
    /** The event it takes: AWS Lambda's, or FF's original wrapped one. */
    eventFormat: 'lambda' | 'wrapped';
    error: string | null;
    createdAt: string;
    updatedAt: string;
  };
  url: FunctionUrl | null;
  /** Its variables' and secrets' names: never their values. */
  variables: string[];
  secrets: string[];
  account: AccountSummary;
  recentCalls: Call[];
  recentErrors: Call[];
}

export interface CallData extends Call {
  input: unknown;
  output: unknown;
  error: string | null;
  inputTruncated: boolean;
  outputTruncated: boolean;
  errorTruncated: boolean;
}

export interface LogLine {
  time: string;
  instance: string | null;
  requestId: string | null;
  stream: string | null;
  message: string;
}

/** What an operator asks to look at: each is recorded in the account's audit log, with the reason. */
export type Look = { kind: 'code' } | { kind: 'call'; callId: string } | { kind: 'logs'; callId?: string };

/** The look's dialog: its title, and what it says the owners will see. */
export function lookDialog(look: Look, functionName: string): { title: string; body: string; confirmLabel: string } {
  const what =
    look.kind === 'code' ? `the code of ${functionName}` : look.kind === 'call' ? `what call ${look.callId} sent and got back, and its error` : look.callId ? `the log lines of call ${look.callId}` : `the last hour's log lines of ${functionName}`;
  return {
    title: look.kind === 'code' ? 'View the code?' : look.kind === 'call' ? "View the call's data?" : 'View the logs?',
    body: `This shows ${what}: the customer's data. The account's owners see in their audit log that FF looked, with your reason.`,
    confirmLabel: 'View',
  };
}

/** "No account, function or call matches …", or what was found: "1 account, 2 functions". */
export function searchSummary(results: SearchResults, q: string): string {
  const parts = (
    [
      [results.accounts.length, 'account'],
      [results.functions.length, 'function'],
      [results.calls.length, 'call'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, noun]) => `${n} ${noun}${n === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : `No account, function or call matches "${q}".`;
}

/** A call's outcome to read: its status, and a failure's type. */
export const outcome = (call: Pick<Call, 'status' | 'errorType'>): string => (call.errorType ? `${call.status} · ${call.errorType}` : call.status);

/** Where a call was found: the history, or only its usage record once the history no longer keeps it. */
export const foundIn = (call: Pick<CallHit, 'inHistory'>): string => (call.inHistory ? 'the history' : 'its usage record only: the history no longer keeps it');

/** What brought a call, to read. */
export const sourceText = (source: CallSource): string => ({ api: 'API', url: 'URL', schedule: 'Schedule' })[source] ?? source;

/** The event a function takes, to read. */
export const eventFormatText = (format: FunctionPage['function']['eventFormat']): string =>
  format === 'wrapped' ? "FF's original wrapped event, from before AWS Lambda's" : "AWS Lambda's";

/** A function's URL, to read: who may call it, and whether browsers may from other sites. */
export function urlText(url: FunctionUrl): string {
  const who = url.authType === 'NONE' ? 'anyone may call it' : 'only with an API key of the account';
  return `${who}${url.cors ? ', with CORS' : ''}`;
}

/** A URL's own domains, to read: each with where it stands. */
export const domainsText = (domains: Domain[]): string =>
  domains.length ? domains.map(({ domain, status }) => `${domain} (${status})`).join(', ') : 'none';

/** Names, to read: "A, B", or "none". */
export const namesText = (names: string[]): string => (names.length ? names.join(', ') : 'none');

/** "1.09 ms", "2,000 ms". */
export const milliseconds = (ms: number): string => `${ms.toLocaleString('en', { maximumFractionDigits: 2 })} ms`;

/** A value of a call as the history keeps it: JSON, indented; or the start of its JSON text, as it is, when cut. */
export function callValue(value: unknown, truncated: boolean): string {
  if (truncated && typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

/** What the history says of a value it kept only the start of. */
export const TRUNCATED = 'Truncated: the history keeps the first 64 KiB.';

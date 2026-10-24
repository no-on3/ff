import axios from 'axios';
import { config } from '../config';
import { requestHeaders } from '../lib/session';
import type { AuthType, FunctionUrl, UrlCors } from '../lib/function-url';
import type { CustomDomain } from '../lib/custom-domains';
import type { Schedule } from '../lib/schedules';

const api = axios.create({
  baseURL: config.apiUrl,
  headers: {
    'Content-Type': 'application/json',
  },
});

/** What the API client needs from the login. Development mode has none. */
export interface ApiAuth {
  /** The access token to send, renewed first when it is about to expire. */
  accessToken(): Promise<string | undefined>;
  /** The API answered 401: the session is over. `message` is the API's reason. */
  onUnauthorized(message: string): void;
}

const NO_LOGIN: ApiAuth = { accessToken: async () => undefined, onUnauthorized: () => undefined };
let auth: ApiAuth = NO_LOGIN;
let accountId: string | undefined;

/** Called once at start-up in OIDC mode, before the first request. */
export function setApiAuth(next: ApiAuth | null): void {
  auth = next ?? NO_LOGIN;
}

/** The account every request acts for (X-FF-Account), as chosen from GET /me. */
export function setApiAccount(id: string | undefined): void {
  accountId = id;
}

// Each request carries the user's token and the account it acts for (D4).
api.interceptors.request.use(async (request) => {
  for (const [name, value] of Object.entries(requestHeaders(await auth.accessToken(), accountId))) {
    request.headers.set(name, value);
  }
  return request;
});

api.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 401) {
    const message = (error.response.data as { message?: unknown } | undefined)?.message;
    auth.onUnauthorized(typeof message === 'string' && message ? message : 'Authentication required');
  }
  return Promise.reject(error);
});

export type Runtime = 'nodejs' | 'python';
export type FunctionStatus = 'CREATING' | 'ACTIVE' | 'ERROR' | 'DELETED';
/** How a function's code comes: inline, the one file of `code`; or zip, a package uploaded. contract.test.ts checks them against the API's. */
export const PACKAGE_TYPES = ['inline', 'zip'] as const;
export type PackageType = (typeof PACKAGE_TYPES)[number];

/** A function, as the API returns it. */
export interface Function {
  id: string;
  name: string;
  /** The account that owns the function (D1). */
  accountId: string;
  runtime: Runtime;
  /** Inline code; empty for a package, which the console doesn't edit. */
  code: string;
  packageType: PackageType;
  /** What its runtime calls, as AWS Lambda's handler: function.handler unless it names another. */
  handler: string;
  /** Its code's SHA-256 in base64, and its size in bytes, as AWS Lambda's CodeSha256 and CodeSize. */
  codeSha256: string;
  codeSize: number;
  /** MB */
  memory: number;
  /** Seconds */
  timeout: number;
  status: FunctionStatus;
  /** Why the function is in ERROR. */
  error?: string | null;
  minInstances: number;
  maxInstances: number;
  scaleToZero: boolean;
  /** What its handler gets: AWS Lambda's event, the input itself; or, for a function made before, FF's original wrapper. */
  eventFormat: EventFormat;
  metadata?: Record<string, unknown> | null;
  /**
   * Its environment variables, by name: in the answers of GET /functions/:id, a create and an update; not in the
   * list. Its secrets' values are never in any answer.
   */
  environment?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** What POST /functions accepts. */
export type NewFunction = Pick<Function, 'name' | 'runtime' | 'code' | 'memory' | 'timeout'> & {
  metadata?: Record<string, unknown>;
  environment?: Record<string, string>;
  /** Write-only: never in any answer. */
  secrets?: Record<string, string>;
};

/** What a function's handler gets as its event. contract.test.ts checks them against the API's. */
export const EVENT_FORMATS = ['lambda', 'wrapped'] as const;
export type EventFormat = (typeof EVENT_FORMATS)[number];

/** What PUT /functions/:id accepts: any subset of these. `environment` replaces all the variables, and rolls out. */
export type FunctionUpdate = Partial<Pick<Function, 'name' | 'runtime' | 'code' | 'memory' | 'timeout' | 'eventFormat'>> & {
  environment?: Record<string, string>;
};

/**
 * Every status an invocation can have: the API's, which contract.test.ts checks.
 * THROTTLED: no instance could take the call in time (P-15). LOST: the backend
 * stopped during the call, so its answer is unknown (P-20). Neither is billed.
 * SUCCESS has been in the database's list from the start, but nothing writes it.
 */
export const INVOCATION_STATUSES = ['SUCCESS', 'ERROR', 'TIMEOUT', 'RUNNING', 'COMPLETED', 'THROTTLED', 'LOST'] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

/** What brought an invocation: the API's invoke, the function's URL, one of its schedules, or an asynchronous call's attempt. contract.test.ts checks them. */
export const INVOCATION_SOURCES = ['api', 'url', 'schedule', 'async', 'sqs'] as const;
export type InvocationSource = (typeof INVOCATION_SOURCES)[number];

/** An invocation's fields, as the API's entity names them: contract.test.ts checks them against it. */
export const INVOCATION_FIELDS = [
  'id',
  'requestId',
  'attempt',
  'functionId',
  'input',
  'output',
  'status',
  'source',
  'duration',
  'memoryUsed',
  'error',
  'inputTruncated',
  'outputTruncated',
  'errorTruncated',
  'createdAt',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof FunctionInvocation>;

/** An invocation, as the API returns it: from POST /functions/:id/invoke, and in the history. */
export interface FunctionInvocation {
  id: string;
  /** The request's ID, which its log lines name: the invocation's own, but an asynchronous call's retries keep the first attempt's. */
  requestId: string;
  /** Which attempt of its request it was: an asynchronous call's are counted from 1; any other call is its first. */
  attempt: number;
  functionId: string;
  /** In the history, the start of its JSON text, as a string, when inputTruncated. */
  input: unknown;
  /** In the history, the start of its JSON text, as a string, when outputTruncated. */
  output: unknown;
  status: InvocationStatus;
  /** What brought it: the API, the function's URL, a schedule, or an asynchronous call. */
  source: InvocationSource;
  /** Milliseconds, as the runtime measured it. */
  duration: number;
  /** MB: the runtime's peak memory. */
  memoryUsed?: number | null;
  error?: string | null;
  /** The history kept only the first 64 KiB of the input, to keep little of the customer's users' data. The invoke's own answer has it whole. */
  inputTruncated: boolean;
  /** The same, for the output. */
  outputTruncated: boolean;
  /** The history kept only the first 64 KiB of the error. */
  errorTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}
// A field missing from INVOCATION_FIELDS stops the build.
type UnlistedInvocationField = Exclude<keyof FunctionInvocation, (typeof INVOCATION_FIELDS)[number]>;
const everyInvocationFieldListed: [UnlistedInvocationField] extends [never] ? true : never = true;
void everyInvocationFieldListed;

/** The answer to an asynchronous call, 202: its request ID, which each of its attempts keeps. contract.test.ts checks it. */
export const ASYNC_INVOCATION_FIELDS = ['requestId'] as const satisfies ReadonlyArray<keyof AsyncInvocation>;
export interface AsyncInvocation {
  requestId: string;
}

/** One page of GET /functions/:id/invocations, newest first. */
export interface InvocationPage {
  invocations: FunctionInvocation[];
  total: number;
}

/**
 * A function's secret, as the API says it: its name, and when its value was set. The value never comes back.
 * contract.test.ts checks these names against the API's.
 */
export const SECRET_FIELDS = ['name', 'updatedAt'] as const;
export type SecretView = Record<(typeof SECRET_FIELDS)[number], string>;

/** GET and PATCH /functions/:id/secrets. A change rolls out a new version, and the answer comes once it is live. */
export const secretsApi = {
  list: (functionId: string) => api.get<{ secrets: SecretView[] }>(`/functions/${functionId}/secrets`),
  /** Each name to its new value, or to null to remove it. */
  change: (functionId: string, secrets: Record<string, string | null>) =>
    api.patch<{ secrets: SecretView[] }>(`/functions/${functionId}/secrets`, { secrets }),
};

/**
 * GET, POST, PUT and DELETE /functions/:id/url: the function's URL, as AWS
 * Lambda's function URL configuration. GET answers 404 for a function without one.
 */
export const functionUrlApi = {
  get: (functionId: string) => api.get<FunctionUrl>(`/functions/${functionId}/url`),
  create: (functionId: string, configuration: { authType: AuthType; cors: UrlCors | null }) =>
    api.post<FunctionUrl>(`/functions/${functionId}/url`, configuration),
  /** What is sent changes, what is left out stays; cors null removes CORS. */
  update: (functionId: string, configuration: { authType?: AuthType; cors?: UrlCors | null }) =>
    api.put<FunctionUrl>(`/functions/${functionId}/url`, configuration),
  remove: (functionId: string) => api.delete(`/functions/${functionId}/url`),
};

/** A function URL's own domains: listed, added, checked again, removed. */
export const domainsApi = {
  list: (functionId: string) => api.get<CustomDomain[]>(`/functions/${functionId}/url/domains`),
  add: (functionId: string, domain: string) => api.post<CustomDomain>(`/functions/${functionId}/url/domains`, { domain }),
  verify: (functionId: string, domain: string) => api.post<CustomDomain>(`/functions/${functionId}/url/domains/${encodeURIComponent(domain)}/verify`),
  remove: (functionId: string, domain: string) => api.delete(`/functions/${functionId}/url/domains/${encodeURIComponent(domain)}`),
};

/**
 * A function's settings for its calls that don't wait, as AWS Lambda's
 * EventInvokeConfig: null values are Lambda's defaults. contract.test.ts checks
 * the fields against the API's.
 */
export const EVENT_INVOKE_CONFIG_FIELDS = ['functionArn', 'maximumRetryAttempts', 'maximumEventAgeInSeconds', 'destinationConfig', 'lastModified'] as const satisfies ReadonlyArray<
  keyof EventInvokeConfig
>;
export interface EventInvokeConfig {
  functionArn: string;
  maximumRetryAttempts: number | null;
  maximumEventAgeInSeconds: number | null;
  /** Each destination's ARN, another function of the account; none when it has none. */
  destinationConfig: { onSuccess: { destination?: string }; onFailure: { destination?: string } };
  lastModified: string;
}

/** GET, PUT and DELETE /functions/:id/event-invoke-config. GET answers 404 for a function without settings: its calls follow Lambda's defaults. */
export const eventInvokeConfigApi = {
  get: (functionId: string) => api.get<EventInvokeConfig>(`/functions/${functionId}/event-invoke-config`),
  /** Replaced whole, as Lambda's PutFunctionEventInvokeConfig: what is left out goes back to Lambda's default. */
  put: (functionId: string, body: Record<string, unknown>) => api.put<EventInvokeConfig>(`/functions/${functionId}/event-invoke-config`, body),
  remove: (functionId: string) => api.delete(`/functions/${functionId}/event-invoke-config`),
};

/** A function's schedules, and an expression's next runs for the form's preview. */
export const schedulesApi = {
  list: (functionId: string) => api.get<Schedule[]>(`/functions/${functionId}/schedules`),
  create: (functionId: string, schedule: Record<string, unknown>) => api.post<Schedule>(`/functions/${functionId}/schedules`, schedule),
  /** What is sent changes, what is left out stays. */
  update: (functionId: string, id: string, changes: Record<string, unknown>) => api.put<Schedule>(`/functions/${functionId}/schedules/${id}`, changes),
  remove: (functionId: string, id: string) => api.delete(`/functions/${functionId}/schedules/${id}`),
  nextRuns: (expression: string) => api.get<{ runs: string[] }>('/schedules/next-runs', { params: { expression } }),
};

/** GET and PUT /functions/:id/scaling-config. Each instance serves one call at a time. */
export interface ScalingConfig {
  /** Instances kept running even when idle. */
  minInstances: number;
  /** The most instances autoscaling may run. */
  maxInstances: number;
  /** Whether the function scales to zero when idle: exactly when minInstances is 0. */
  scaleToZero: boolean;
}

export type ScalingLimits = Pick<ScalingConfig, 'minInstances' | 'maxInstances'>;

export const functionsApi = {
  getAllFunctions: () => api.get<Function[]>('/functions'),

  getFunction: (id: string) => api.get<Function>(`/functions/${id}`),

  createFunction: (data: NewFunction) => api.post<Function>('/functions', data),

  updateFunction: (id: string, data: FunctionUpdate) => api.put<Function>(`/functions/${id}`, data),

  deleteFunction: (id: string) => api.delete(`/functions/${id}`),

  /** `input` is the handler's event, any JSON value; for a function made before, its event.body. */
  invokeFunction: (id: string, input: unknown) =>
    api.post<FunctionInvocation>(`/functions/${id}/invoke`, { input }),

  /** The same call without waiting, as AWS Lambda's invocation type Event: kept, then run and retried on failure. */
  invokeFunctionAsync: (id: string, input: unknown) =>
    api.post<AsyncInvocation>(`/functions/${id}/invoke`, { input, invocationType: 'Event' }),

  getFunctionInvocations: (id: string, limit = 20) =>
    api.get<InvocationPage>(`/functions/${id}/invocations`, { params: { limit } }),
};

/** A line of a function's log (P-43). contract.test.ts checks these names against the API's. */
export const LOG_LINE_FIELDS = ['time', 'instance', 'requestId', 'stream', 'message'] as const;
export interface FunctionLogLine {
  /** RFC 3339, UTC, nine decimals. */
  time: string;
  /** The instance that wrote it; null on the log store's notice of dropped lines. */
  instance: string | null;
  /** The invocation whose line it is, from its START to its REPORT. */
  requestId: string | null;
  /** `ff` is the log store's notice that the account's limit dropped lines. */
  stream: 'stdout' | 'stderr' | 'ff' | null;
  message: string;
}

export const LOGS_PAGE_FIELDS = ['lines', 'next'] as const;
/** A page of lines, oldest first; `next` is the cursor to the older ones. */
export interface FunctionLogsPage {
  lines: FunctionLogLine[];
  next: string | null;
}

/** What GET /functions/:id/logs accepts that the console sends (P-43). */
export const LOGS_QUERY_PARAMS = ['limit', 'sinceSeconds', 'q', 'requestId', 'cursor'] as const;
export type LogsQuery = Partial<Record<'limit' | 'sinceSeconds', number> & Record<'q' | 'requestId' | 'cursor', string>>;

/** The live tail's failure before any event: the API's status and message. */
export class LogStreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const logsApi = {
  page: (functionId: string, query: LogsQuery) => api.get<FunctionLogsPage>(`/functions/${functionId}/logs`, { params: query }),

  /**
   * The live tail (P-43): Server-Sent Events, read with fetch, since a browser's
   * EventSource can't send the token. Gives each chunk of text as it comes, until
   * the stream ends or `signal` aborts it; rejects with LogStreamError when the API
   * refuses it, as 404 for a function that isn't the account's.
   */
  async stream(functionId: string, filter: Pick<LogsQuery, 'q' | 'requestId'>, signal: AbortSignal, onText: (text: string) => void): Promise<void> {
    const search = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
    const headers = { Accept: 'text/event-stream', ...requestHeaders(await auth.accessToken(), accountId) };
    const res = await fetch(`${config.apiUrl}/functions/${functionId}/logs/stream${search.size ? `?${search}` : ''}`, { headers, signal });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      const message = Array.isArray(body.message) ? body.message.join('; ') : typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      if (res.status === 401) auth.onUnauthorized(message);
      throw new LogStreamError(res.status, message);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onText(value);
    }
  },
};

/**
 * What GET /usage counts for a function and for the account (P-22), as D7 bills
 * it: requests billed (successes, errors and timeouts), billed duration in ms,
 * GB-seconds, and the calls not billed: throttled, platform errors, lost.
 * contract.test.ts checks these names against the API's.
 */
export const USAGE_AMOUNTS = ['requests', 'billedMs', 'gbSeconds', 'throttled', 'platformErrors', 'lost'] as const;
/** GB-seconds come as an exact decimal string; the rest are whole numbers. */
export type UsageAmounts = Record<Exclude<(typeof USAGE_AMOUNTS)[number], 'gbSeconds'>, number> & { gbSeconds: string };

export interface FunctionUsage extends UsageAmounts {
  functionId: string;
  /** Its name in its latest call of the month. */
  functionName: string;
  /** Deleted since: its usage stays. */
  deleted: boolean;
  /** Its estimated cost before the free tier, rounded to the minor unit (P-30); null without a price book. */
  cost: string | null;
}

/**
 * The month's estimated cost at FF's prices (P-30, D8): AWS Lambda's, in TND.
 * Each amount is rounded to the minor unit once, from the exact ones.
 * contract.test.ts checks these names against the API's.
 */
export const USAGE_ESTIMATE_FIELDS = ['currency', 'usage', 'freeTier', 'volumeTiers', 'monthlyFee', 'total', 'pricedFrom', 'priceBooks'] as const;
export interface UsageEstimate {
  currency: string;
  /** Every function, before the free tier. */
  usage: string;
  /** What the free tier takes off: zero or less. */
  freeTier: string;
  /** What the duration tiers past 6 billion GB-s take off: zero or less. */
  volumeTiers: string;
  monthlyFee: string;
  total: string;
  /** The first instant priced: the month's start, unless the first price book starts later. */
  pricedFrom: string;
  priceBooks: string[];
}

/** A database's fields in GET /usage, as the API's DatabaseUsageView names them: contract.test.ts checks them. */
export const DATABASE_USAGE_FIELDS = ['databaseId', 'name', 'deleted', 'hours', 'gbMonths', 'sizeBytes', 'cost'] as const satisfies ReadonlyArray<keyof DatabaseUsage>;
/** A customer's database in the month, as its hourly measures counted it. */
export interface DatabaseUsage {
  databaseId: string;
  /** Its name at its latest measure of the month. */
  name: string;
  /** Deleted since: its usage stays. */
  deleted: boolean;
  /** The hours it was measured in. */
  hours: number;
  /** Its storage in GB-months, to six decimals, as a string. */
  gbMonths: string;
  /** Its size at its latest measure, in bytes. */
  sizeBytes: number;
  /** Before the free tier; null without a price book. */
  cost: string | null;
}

/** A bucket's fields in GET /usage, as the API's BucketUsageView names them: contract.test.ts checks them. */
export const BUCKET_USAGE_FIELDS = [
  'bucketId',
  'name',
  'deleted',
  'hours',
  'gbMonths',
  'sizeBytes',
  'objects',
  'tier1Requests',
  'tier2Requests',
  'bytesDownloaded',
  'bytesUploaded',
  'cost',
] as const satisfies ReadonlyArray<keyof BucketUsage>;
/** A customer's bucket in the month, as its hourly measures and the front door's counts counted it. */
export interface BucketUsage {
  bucketId: string;
  name: string;
  /** Deleted since: its usage stays. */
  deleted: boolean;
  /** The hours it was measured in. */
  hours: number;
  /** Its storage in GB-months, to six decimals, as a string. */
  gbMonths: string;
  /** What it held at its latest measure, in bytes, and its objects then. */
  sizeBytes: number;
  objects: number;
  /** S3's first class of request (PUT, COPY, POST, LIST) and its second (GET and the others); deletes are free. */
  tier1Requests: number;
  tier2Requests: number;
  /** The bytes its requests sent out, counted and not billed, and those they brought in, free as on S3. */
  bytesDownloaded: number;
  bytesUploaded: number;
  /** Before the free tier; null without a price book. */
  cost: string | null;
}

/** GET /usage: one month by the UTC calendar. */
export interface MonthlyUsage {
  /** YYYY-MM */
  month: string;
  /** Each function with calls in the month, the most GB-seconds first, then any that cost something without a call. */
  functions: FunctionUsage[];
  /** Each of the account's databases measured in the month, the most GB-months first. */
  databases: DatabaseUsage[];
  /** Each of its buckets measured, or asked anything, in the month, the most GB-months first. */
  buckets: BucketUsage[];
  totals: UsageAmounts;
  /** null when no price book covers the month. */
  estimate: UsageEstimate | null;
}

export const usageApi = {
  /** `month`: YYYY-MM, by the UTC calendar. */
  getMonth: (month: string) => api.get<MonthlyUsage>('/usage', { params: { month } }),

  /** The same month as CSV, for a spreadsheet. */
  getMonthCsv: (month: string) =>
    api.get<string>('/usage', { params: { month }, headers: { Accept: 'text/csv' }, responseType: 'text' }),
};

/**
 * GET /billing/balance (P-32): the account's balance and this month's charges.
 * Money is a string with every decimal of its currency, never a JSON number.
 * contract.test.ts checks these names against the API's.
 */
export const BALANCE_FIELDS = ['currency', 'balance', 'shadowMode', 'month', 'charged', 'ratedUntil', 'credit'] as const;
/** D9's balance check (P-33): whether invokes go on. contract.test.ts checks these names against the API's. */
export const CREDIT_STATE_FIELDS = ['state', 'buffer', 'belowBufferSince', 'invokesStopAt'] as const;
export interface CreditState {
  /** ok: above the buffer, or the billing trial; grace: below it, invokes still go; stopped: invokes answer 402. */
  state: 'ok' | 'grace' | 'stopped';
  /** How far below zero the balance may go, with the currency's decimals: "1.000". */
  buffer: string;
  belowBufferSince: string | null;
  /** When invokes stop, or stopped. */
  invokesStopAt: string | null;
}
export interface Balance {
  currency: string;
  /** The credit left; below zero, usage the credit didn't cover. */
  balance: string;
  /** D9's billing trial: usage is rated each hour and shown, not debited. */
  shadowMode: boolean;
  /** This month, YYYY-MM, UTC. */
  month: string;
  /** This month's hourly charges added up: debited, or in the trial only rated. */
  charged: string;
  /** The end of the last hour rated; usage after it isn't charged yet. */
  ratedUntil: string | null;
  credit: CreditState;
}

/** What moved the balance (P-32): a usage debit's hour, a credit. */
export interface BillingTransaction {
  id: string;
  kind: string;
  occurredAt: string;
  createdAt: string;
  /** What it moved the balance by: a debit is below zero. */
  amount: string;
  currency: string;
}

/** When the owners get a low-balance e-mail (P-33): the account's shares of the last credit, or FF's. */
export interface Alerts {
  lowBalancePercents: number[] | null;
  defaultPercents: number[];
}

/**
 * A pro-forma for a bank transfer (P-35, D9): the credit, the VAT on top, the
 * reference for the transfer's label, and the transfer once FF recorded it.
 * contract.test.ts checks these names against the API's.
 */
export const PRO_FORMA_FIELDS = ['id', 'reference', 'status', 'currency', 'credit', 'vatPercent', 'vat', 'total', 'createdAt', 'buyer', 'seller', 'bank', 'transfer', 'cancelledAt'] as const;
export const TRANSFER_FIELDS = ['received', 'withheld', 'receivedOn', 'recordedAt', 'credited', 'withheldCreditedAt'] as const;
/** GET /billing/pro-formas: the account's pro-formas, and the VAT rate one asked for now gets (P-36: rates are dated data). */
export const PRO_FORMAS_PAGE_FIELDS = ['proFormas', 'vatPercent'] as const;
export interface ProFormasPage {
  proFormas: ProForma[];
  /** In percent: today's, in Tunisia. */
  vatPercent: number;
}

/** An issued invoice or credit note (P-36). contract.test.ts checks these names against the API's. */
export const INVOICE_FIELDS = ['id', 'kind', 'number', 'month', 'issuedOn', 'currency', 'subtotal', 'vat', 'stampDuty', 'total', 'corrects', 'reason'] as const;
export interface Invoice {
  id: string;
  /** invoice: a month's credit bought; credit_note: an invoice corrected. */
  kind: 'invoice' | 'credit_note';
  /** FAC-2026-000001, AV-2026-000001. */
  number: string;
  /** An invoice's month, YYYY-MM. */
  month: string | null;
  /** YYYY-MM-DD, in Tunisia. */
  issuedOn: string;
  currency: string;
  subtotal: string;
  vat: string;
  /** Taken from the credit when the invoice was issued. */
  stampDuty: string;
  total: string;
  /** A credit note's invoice, by its number. */
  corrects: string | null;
  reason: string | null;
}

/** Who sells, who buys, and where to pay, as each pro-forma carries them. */
export const PRO_FORMA_PARTY_FIELDS = { buyer: ['name', 'taxId'], seller: ['name', 'taxId', 'address'], bank: ['name', 'iban', 'bic'] } as const;
export interface Transfer {
  /** What reached FF's account. */
  received: string;
  /** What the buyer withheld at source; "0.000" for none. */
  withheld: string;
  /** The transfer's date on the bank statement, YYYY-MM-DD. */
  receivedOn: string;
  recordedAt: string;
  /** The credit added with the transfer: the credit less the share withheld. */
  credited: string;
  /** When the withholding certificate came and the withheld share was credited. */
  withheldCreditedAt: string | null;
}
export interface ProForma {
  id: string;
  /** FF-XXXX-XXXX: what the buyer writes in the transfer's label. */
  reference: string;
  /** pending: waiting for the transfer; paid: FF recorded it; cancelled: an owner or FF cancelled it before any transfer (P-74). */
  status: 'pending' | 'paid' | 'cancelled';
  currency: string;
  credit: string;
  vatPercent: number;
  vat: string;
  total: string;
  createdAt: string;
  /** The account as it was when the pro-forma was asked for. */
  buyer: { name: string; taxId: string | null };
  seller: { name: string; taxId: string | null; address: string };
  /** Where to pay. */
  bank: { name: string; iban: string; bic: string | null };
  transfer: Transfer | null;
  /** When it was cancelled; a transfer that came anyway still paid it. */
  cancelledAt: string | null;
}

export const billingApi = {
  getBalance: () => api.get<Balance>('/billing/balance'),
  /** Newest first; `before` is the previous page's `next`. */
  getTransactions: (before?: string, limit = 20) =>
    api.get<{ transactions: BillingTransaction[]; next: string | null }>('/billing/transactions', { params: { limit, before } }),
  getAlerts: () => api.get<Alerts>('/billing/alerts'),
  /** An owner's shares, or null for FF's. */
  setAlerts: (lowBalancePercents: number[] | null) => api.put<Alerts>('/billing/alerts', { lowBalancePercents }),
  /** An owner asks for a pro-forma: the credit before tax, such as "50.000". */
  requestProForma: (credit: string) => api.post<ProForma>('/billing/pro-formas', { credit }),
  /** The account's last 100, newest first, with the VAT rate a new one gets. */
  getProFormas: () => api.get<ProFormasPage>('/billing/pro-formas'),
  getProForma: (id: string) => api.get<ProForma>(`/billing/pro-formas/${encodeURIComponent(id)}`),
  /** An owner's, of a pending one (P-74): nobody should pay it any more. */
  cancelProForma: (id: string) => api.post<ProForma>(`/billing/pro-formas/${encodeURIComponent(id)}/cancel`),
  /** The account's issued invoices and credit notes, newest first (P-36). */
  getInvoices: () => api.get<{ invoices: Invoice[] }>('/billing/invoices'),
  /** An invoice or credit note's PDF, as it was issued. */
  getInvoicePdf: (id: string) => api.get<Blob>(`/billing/invoices/${encodeURIComponent(id)}/pdf`, { responseType: 'blob' }),
  /** A month's usage statement, YYYY-MM, as rated so far. */
  getStatementPdf: (month: string) => api.get<Blob>(`/billing/statements/${encodeURIComponent(month)}/pdf`, { responseType: 'blob' }),
};

/** A metrics answer's series names, as the API's DTO names them, after CloudWatch's: contract.test.ts checks them. */
export const METRIC_NAMES = ['Invocations', 'Errors', 'Throttles', 'ColdStarts', 'Duration', 'Instances'] as const;

/** GET /functions/:id/metrics and GET /metrics: a point per period of the window, oldest first. */
export interface Metrics {
  /** Seconds per point. */
  period: number;
  start: string;
  /** Excluded. */
  end: string;
  /** Each period's start. */
  timestamps: string[];
  metrics: {
    /** Calls that reached the function, failed or not. */
    Invocations: number[];
    /** Its errors and timeouts, FF's failures, and calls lost when the backend stopped. */
    Errors: number[];
    /** Calls refused: no instance free in time, or the account's rate limit. */
    Throttles: number[];
    ColdStarts: number[];
    /** Milliseconds; null for a period without a measured call. */
    Duration: { Average: Array<number | null>; Maximum: Array<number | null>; p50: Array<number | null>; p95: Array<number | null>; p99: Array<number | null> };
    Instances: { Maximum: number[]; Average: number[] };
  };
}

export const metricsApi = {
  forFunction: (id: string, params: { period: number; start?: string; end?: string }) => api.get<Metrics>(`/functions/${id}/metrics`, { params }),
  forAccount: (params: { period: number; start?: string; end?: string }) => api.get<Metrics>('/metrics', { params }),
};

export type AccountStatus = 'pending' | 'active' | 'rejected' | 'suspended' | 'closed';
export type Role = 'owner' | 'developer' | 'viewer';

/** What a plan allows (D5): GET /me gives each account's. */
export interface PlanLimits {
  functions: number;
  /** The most memory one function may have, in MB. */
  memoryMb: number;
  /** The longest timeout one function may have, in seconds. */
  timeoutSeconds: number;
  instancesPerFunction: number;
  /** All the account's functions together. */
  quota: { pods: number; cpu: string; memory: string };
  writesPerMinute: number;
  invokesPerSecond: number;
  logRetentionDays: number;
  historyRetentionDays: number;
  /** Seconds without a call before a function scales to zero. */
  idleSeconds: number;
  internetEgress: boolean;
  /** Customers' own domains for their functions' URLs, all together. */
  customDomains: number;
  /** Functions' schedules, all together. */
  schedules: number;
  /** Customers' PostgreSQL databases, all together. */
  databases: number;
  /** What one database may hold, in MB, before its new sessions start read-only. */
  databaseStorageMb: number;
  /** The sessions one database may have at once. */
  databaseConnections: number;
  /** Customers' buckets, all together. */
  buckets: number;
  /** What the account's buckets may hold together, in MB. */
  bucketStorageMb: number;
  /** S3 requests per second, all the keys together. */
  storageRequestsPerSecond: number;
  /** The largest object one PutObject may send, in MB. */
  maxObjectMb: number;
  /** Customers' queues, all together. */
  queues: number;
  /** The queues one function may read in batches. */
  eventSourceMappingsPerFunction: number;
  /** SQS requests per second, all the keys together. */
  queueRequestsPerSecond: number;
  /** What the account's messages may hold together, in MB, its functions' waiting asynchronous calls among them. */
  queueStorageMb: number;
}

export interface Plan {
  id: string;
  name: string;
  limits: PlanLimits;
}

/** One of the user's accounts, in GET /me. */
/** An account's fields in GET /me, as the API's DTO names them: contract.test.ts checks them against it. */
export const ME_ACCOUNT_FIELDS = [
  'id',
  'name',
  'status',
  'role',
  'plan',
  'internetEgress',
  'dataDeletionDueAt',
  'dataDeletedAt',
  'storageDisabledAt',
  'storageDisabledReason',
  'bucketStorageNotice',
] as const satisfies ReadonlyArray<keyof MeAccount>;

export interface MeAccount {
  /** 12 digits. */
  id: string;
  name: string;
  status: AccountStatus;
  /** The user's role in it. */
  role: Role;
  /** Its plan, whose limits the API applies. */
  plan: Plan;
  /** Whether its functions may reach the internet. */
  internetEgress: boolean;
  /** When a closed account's functions, their history and logs are deleted; null unless closed. */
  dataDeletionDueAt: string | null;
  /** When they were deleted; null until then. */
  dataDeletedAt: string | null;
  /** When FF turned the account's databases, buckets and queues off: their users can't log in, its keys are refused. null while they are on. */
  storageDisabledAt: string | null;
  /** FF's reason for it. */
  storageDisabledReason: string | null;
  /** The share of its plan's storage its buckets reached together at their last measure: at 100, uploads wait for room; null under 80%. */
  bucketStorageNotice: 80 | 100 | null;
}
// A field missing from ME_ACCOUNT_FIELDS stops the build.
type UnlistedMeAccountField = Exclude<keyof MeAccount, (typeof ME_ACCOUNT_FIELDS)[number]>;
const everyMeAccountFieldListed: [UnlistedMeAccountField] extends [never] ? true : never = true;
void everyMeAccountFieldListed;

/** The languages of the e-mails FF sends a user, as PATCH /me takes them: French at first. */
export const EMAIL_LANGUAGES = [
  { locale: 'fr-TN', label: 'Français' },
  { locale: 'en', label: 'English' },
] as const;
export type Locale = (typeof EMAIL_LANGUAGES)[number]['locale'];

/** GET /me: the logged-in user and their accounts. */
export interface Me {
  /** null when the API runs in development mode, which acts without a user. */
  user: { id: string; email: string; name: string | null; locale: string } | null;
  accounts: MeAccount[];
}

/** An account, as its members see it: GET, POST and PATCH /accounts. */
export interface Account extends MeAccount {
  planId: string;
  /** ISO 3166 code. */
  country: string;
  /** The tax ID (matricule fiscal), for invoices. */
  taxId: string | null;
  /** Whether its functions may reach the internet. */
  internetEgress: boolean;
  useCase: string | null;
  createdAt: string;
}

/** What POST /accounts accepts. */
export interface NewAccount {
  name: string;
  useCase?: string;
  country?: string;
  taxId?: string;
}

/** What PATCH /accounts/:id accepts; a null tax ID removes it. */
export interface AccountUpdate {
  name?: string;
  taxId?: string | null;
}

export const SCOPES = [
  'functions:read',
  'functions:write',
  'functions:invoke',
  'logs:read',
  'metrics:read',
  'alarms:read',
  'alarms:write',
  'usage:read',
  'databases:read',
  'databases:write',
  'storage:read',
  'storage:write',
  'queues:read',
  'queues:write',
] as const;
export type Scope = (typeof SCOPES)[number];

/** An API key, as GET /api-keys lists it: never its secret. */
export interface ApiKey {
  /** 12 hex characters: the key reads ffk_<id>_<secret>. */
  id: string;
  name: string;
  scopes: Scope[];
  /** The user who created it. */
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** POST /api-keys's answer: the only time the whole key is shown. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

/** What POST /api-keys accepts. */
export interface NewApiKey {
  name: string;
  scopes: Scope[];
  /** ISO 8601; the key never expires without one. */
  expiresAt?: string;
}

/** A member of the account (P-16): GET /members, owners only. */
export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: string;
}

/** An invitation nobody has accepted yet: whoever next logs in with its address joins. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  /** Past its expiry: invite again to renew it. */
  expired: boolean;
}

export interface Members {
  members: Member[];
  invitations: Invitation[];
}

/** The chosen account's members and invitations: its owners' only. */
export const membersApi = {
  listMembers: () => api.get<Members>('/members'),

  /** Invites an address, or renews its invitation with this role. */
  invite: (email: string, role: Role) => api.post<Invitation>('/members', { email, role }),

  changeRole: (userId: string, role: Role) => api.patch<Member>(`/members/${userId}`, { role }),

  removeMember: (userId: string) => api.delete(`/members/${userId}`),

  cancelInvitation: (id: string) => api.delete(`/members/invitations/${id}`),
};

export const accountsApi = {
  me: () => api.get<Me>('/me'),

  /** The user's own settings, for all their accounts: the language of their e-mails. */
  updateMe: (data: { locale: Locale }) => api.patch<Me>('/me', data),

  /** The new account is pending, and its creator its owner. */
  createAccount: (data: NewAccount) => api.post<Account>('/accounts', data),

  getAccount: (id: string) => api.get<Account>(`/accounts/${id}`),

  updateAccount: (id: string, data: AccountUpdate) => api.patch<Account>(`/accounts/${id}`, data),
};

/** How a notification's delivery stands (GET /notifications/deliveries). */
export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_FIELDS = [
  'id',
  'notificationId',
  'kind',
  'channel',
  'target',
  'status',
  'attempts',
  'lastError',
  'responseStatus',
  'createdAt',
  'deliveredAt',
  'nextAttemptAt',
] as const;
/** One delivery of a notification: an e-mail to an owner, or a POST to a webhook, and how it went. */
export interface Delivery {
  id: string;
  /** The notification's ID: the webhook's FF-Event-Id, the same for each of its deliveries. */
  notificationId: string;
  kind: string;
  channel: 'email' | 'webhook';
  /** The e-mail address, or the webhook's URL. */
  target: string;
  status: DeliveryStatus;
  /** The attempts made so far: up to 6. */
  attempts: number;
  lastError: string | null;
  /** The webhook's last HTTP status. */
  responseStatus: number | null;
  createdAt: string;
  deliveredAt: string | null;
  /** When it is tried next; null once delivered or failed. */
  nextAttemptAt: string | null;
}
// A field missing from DELIVERY_FIELDS stops the build.
type UnlistedDeliveryField = Exclude<keyof Delivery, (typeof DELIVERY_FIELDS)[number]>;
const everyDeliveryFieldListed: [UnlistedDeliveryField] extends [never] ? true : never = true;
void everyDeliveryFieldListed;

export const WEBHOOK_SECRET_FIELDS = ['secret', 'createdAt', 'previousExpiresAt'] as const;
/** The secret the account's webhooks are signed with: its owners' only. */
export interface WebhookSecret {
  secret: string;
  createdAt: string;
  /** Until when the previous secret signs too, after a rotation; null otherwise. */
  previousExpiresAt: string | null;
}

/** The account's notifications: its webhooks' secret, a test, and how the latest deliveries went. */
export const notificationsApi = {
  secret: () => api.get<WebhookSecret>('/notifications/webhook-secret'),

  /** A new secret; the previous one signs too for 24 hours. */
  rotate: () => api.post<WebhookSecret>('/notifications/webhook-secret/rotate'),

  test: (data: { webhookUrl?: string; email?: boolean }) => api.post<{ notificationId: string; deliveries: Delivery[] }>('/notifications/test', data),

  deliveries: (limit = 50) => api.get<Delivery[]>('/notifications/deliveries', { params: { limit } }),
};

/** An alarm's state, as CloudWatch's. */
export const ALARM_STATES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'] as const;
export type AlarmState = (typeof ALARM_STATES)[number];

/** What an alarm is, as POST /alarms and PUT /alarms/:id take it. */
export interface AlarmBody {
  name: string;
  /** null: the account's, all its functions together, or its money. */
  functionId: string | null;
  /** The database watched, for DatabaseConnections and VolumeBytesUsed, an hour at a time; null otherwise. */
  databaseId?: string | null;
  /** The bucket watched, by its name, for its storage and its requests; null otherwise. */
  bucketName?: string | null;
  metric: string;
  statistic: string;
  /** Seconds per datapoint: 60, 300 or 3600. */
  period: number;
  comparison: string;
  threshold: number;
  /** N: the last periods judged. */
  evaluationPeriods: number;
  /** M: how many of them must breach. */
  datapointsToAlarm: number;
  treatMissingData: string;
  actions: { email: boolean; webhookUrls: string[] };
}

export const ALARM_FIELDS = [
  'id',
  'name',
  'functionId',
  'databaseId',
  'bucketName',
  'metric',
  'statistic',
  'period',
  'comparison',
  'threshold',
  'evaluationPeriods',
  'datapointsToAlarm',
  'treatMissingData',
  'actions',
  'state',
  'stateReason',
  'stateChangedAt',
  'evaluatedAt',
  'createdAt',
  'updatedAt',
] as const;
/** An alarm, with its state and why. */
export interface Alarm extends AlarmBody {
  id: string;
  state: AlarmState;
  /** Why, in English, as CloudWatch says it. */
  stateReason: string | null;
  stateChangedAt: string | null;
  /** Its last evaluation: every minute. */
  evaluatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
// A field missing from ALARM_FIELDS stops the build.
type UnlistedAlarmField = Exclude<keyof Alarm, (typeof ALARM_FIELDS)[number]>;
const everyAlarmFieldListed: [UnlistedAlarmField] extends [never] ? true : never = true;
void everyAlarmFieldListed;

/** A customer's database's status, as the API's DatabaseStatus names them: contract.test.ts checks them. */
export const DATABASE_STATUSES = ['creating', 'active', 'read_only', 'suspended', 'deleting'] as const;
export type DatabaseStatus = (typeof DATABASE_STATUSES)[number];

/** A database's fields, as the API's DatabaseView names them: contract.test.ts checks them. */
export const DATABASE_FIELDS = [
  'id',
  'name',
  'status',
  'host',
  'port',
  'database',
  'user',
  'connectionUrl',
  'sizeBytes',
  'connections',
  'connectionLimit',
  'storageLimitMb',
  'passwordSetAt',
  'createdAt',
] as const satisfies ReadonlyArray<keyof Database>;

/** A customer's PostgreSQL database, as AWS RDS gives one: never its password, which FF doesn't keep. */
export interface Database {
  id: string;
  /** Its name in the account. */
  name: string;
  status: DatabaseStatus;
  /** The server, as functions and developers reach it. */
  host: string;
  port: number;
  /** Its name on the server, and its user's: the same, opaque. */
  database: string;
  user: string;
  /** How to connect, without the password. */
  connectionUrl: string;
  /** Its size now, in bytes; null when the server could not be asked. */
  sizeBytes: number | null;
  /** Its sessions now; null when the server could not be asked. */
  connections: number | null;
  /** The plan's sessions at most. */
  connectionLimit: number;
  /** The plan's storage for it, in MB: past it, its new sessions start read-only. */
  storageLimitMb: number;
  passwordSetAt: string | null;
  createdAt: string;
}
// A field missing from DATABASE_FIELDS stops the build.
type UnlistedDatabaseField = Exclude<keyof Database, (typeof DATABASE_FIELDS)[number]>;
const everyDatabaseFieldListed: [UnlistedDatabaseField] extends [never] ? true : never = true;
void everyDatabaseFieldListed;

/** A database just made, or given a new password: the password and the connection string, in this answer only. */
export interface DatabaseWithPassword extends Database {
  password: string;
  connectionString: string;
}

/** GET /databases/:id/metrics: a point an hour, oldest first, null for an hour without a measure. */
export interface DatabaseMetrics {
  period: number;
  start: string;
  end: string;
  timestamps: string[];
  metrics: {
    DatabaseConnections: { Maximum: Array<number | null>; Average: Array<number | null> };
    VolumeBytesUsed: { Maximum: Array<number | null>; Average: Array<number | null> };
  };
}

/** The account's PostgreSQL databases: every member reads them; owners and developers make, change and delete them. */
export const databasesApi = {
  list: () => api.get<Database[]>('/databases'),
  get: (id: string) => api.get<Database>(`/databases/${id}`),
  create: (name: string) => api.post<DatabaseWithPassword>('/databases', { name }),
  /** A new password: the old one opens no new session. */
  resetPassword: (id: string) => api.post<DatabaseWithPassword>(`/databases/${id}/password`),
  remove: (id: string) => api.delete(`/databases/${id}`),
  /** Its sessions and size, a point an hour; the last 60 hours by default. */
  metrics: (id: string, params: { start?: string; end?: string } = {}) => api.get<DatabaseMetrics>(`/databases/${id}/metrics`, { params }),
};

/** A bucket's fields, as the API's BucketView names them: contract.test.ts checks them. */
export const BUCKET_FIELDS = ['name', 'status', 'region', 'endpoint', 'url', 'sizeBytes', 'objects', 'measuredAt', 'createdAt'] as const satisfies ReadonlyArray<keyof Bucket>;

/** An access key's fields, as the API's StorageKeyView names them; a key just made adds its secret, the endpoint and the region. */
export const STORAGE_KEY_FIELDS = ['id', 'buckets', 'queues', 'readOnly', 'createdAt', 'lastUsedAt'] as const satisfies ReadonlyArray<keyof StorageKey>;

/** A bucket, as AWS S3 gives one, behind FF's S3 front door (ADR 0009). */
export interface Bucket {
  name: string;
  status: 'active' | 'deleting';
  /** FF's region, as GetBucketLocation answers it. */
  region: string;
  /** The S3 endpoint to give AWS's SDKs and CLI. */
  endpoint: string;
  /** Its own address, virtual-hosted. */
  url: string;
  /** What it held at its last hourly measure, in bytes, and its objects then; null before its first. */
  sizeBytes: number | null;
  objects: number | null;
  /** The hour of that measure. */
  measuredAt: string | null;
  createdAt: string;
}

/** The request metrics a bucket has, as CloudWatch names S3's: each period's Sum. */
export const BUCKET_REQUEST_METRICS = ['AllRequests', 'GetRequests', 'PutRequests', '4xxErrors', '5xxErrors', 'BytesDownloaded', 'BytesUploaded'] as const;
export type BucketRequestMetric = (typeof BUCKET_REQUEST_METRICS)[number];

/** GET /buckets/:name/metrics: what it holds, its hour's measure in each period; its requests, each period's Sum. */
export interface BucketMetrics {
  period: number;
  start: string;
  end: string;
  timestamps: string[];
  metrics: { BucketSizeBytes: { Average: Array<number | null> }; NumberOfObjects: { Average: Array<number | null> } } & Record<BucketRequestMetric, { Sum: number[] }>;
}

/** An access key to the account's buckets: never its secret. */
export interface StorageKey {
  /** AWS_ACCESS_KEY_ID: AKFF and 16 characters. */
  id: string;
  /** The buckets it names; null for none named. Naming neither buckets nor queues, it reaches all the account's. */
  buckets: string[] | null;
  /** The queues it names; null for none named. */
  queues: string[] | null;
  readOnly: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A key just made: its secret this once, with the endpoint and the region. */
export interface CreatedStorageKey extends StorageKey {
  secretAccessKey: string;
  endpoint: string;
  /** The SQS endpoint, AWS_ENDPOINT_URL_SQS, for the account's queues. */
  sqsEndpoint: string;
  region: string;
}

/** The account's buckets: every member lists them; owners and developers make and delete them. */
export const bucketsApi = {
  list: () => api.get<Bucket[]>('/buckets'),
  get: (name: string) => api.get<Bucket>(`/buckets/${name}`),
  create: (name: string) => api.post<Bucket>('/buckets', { name }),
  /** An empty one; with force, its files first. */
  remove: (name: string, force = false) => api.delete(`/buckets/${name}`, { params: force ? { force: 'true' } : {} }),
  /** What it holds and its requests, a point per period: a minute, five or an hour. */
  metrics: (name: string, params: { start?: string; end?: string; period?: 60 | 300 | 3600 } = {}) => api.get<BucketMetrics>(`/buckets/${name}/metrics`, { params }),
};

/** The account's access keys to its buckets: its owners alone see, make and revoke them. */
export const storageKeysApi = {
  list: () => api.get<StorageKey[]>('/storage-keys'),
  /** Naming neither buckets nor queues, it reaches all the account's; naming some, those alone. */
  create: (body: { buckets?: string[]; queues?: string[]; readOnly?: boolean }) => api.post<CreatedStorageKey>('/storage-keys', body),
  revoke: (id: string) => api.delete(`/storage-keys/${id}`),
};

/** SQS's redrive policy: after maxReceiveCount receives, a message goes to the dead-letter queue its ARN names. */
export interface RedrivePolicy {
  deadLetterTargetArn: string;
  maxReceiveCount: number;
}

/** A queue's messages, as SQS counts them, roughly. */
export interface QueueMessages {
  /** That can be received now. */
  available: number;
  /** Received and hidden for their visibility timeout. */
  inFlight: number;
  /** Waiting for their delay. */
  delayed: number;
}

/** A customer's queue (ADR 0010), as GET /queues answers it: SQS's attributes by their names, in seconds and bytes. */
export interface Queue {
  name: string;
  /** Its URL, which SQS's requests name, under the SQS endpoint. */
  url: string;
  arn: string;
  visibilityTimeout: number;
  messageRetentionPeriod: number;
  delaySeconds: number;
  maximumMessageSize: number;
  receiveMessageWaitTimeSeconds: number;
  redrivePolicy: RedrivePolicy | null;
  messages: QueueMessages;
  /** What its messages hold together, as the plan counts them. */
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

/** A queue's fields, as the API's QueueView names them: contract.test.ts checks them. */
export const QUEUE_FIELDS = [
  'name',
  'url',
  'arn',
  'visibilityTimeout',
  'messageRetentionPeriod',
  'delaySeconds',
  'maximumMessageSize',
  'receiveMessageWaitTimeSeconds',
  'redrivePolicy',
  'messages',
  'sizeBytes',
  'createdAt',
  'updatedAt',
] as const satisfies ReadonlyArray<keyof Queue>;

/** The attributes a queue is made or changed with: SQS's, each left as it is when not given; a redrive policy of null removes it. */
export type QueueAttributes = Partial<Pick<Queue, 'visibilityTimeout' | 'messageRetentionPeriod' | 'delaySeconds' | 'maximumMessageSize' | 'receiveMessageWaitTimeSeconds'>> & {
  redrivePolicy?: RedrivePolicy | null;
};

/** A message attribute, as SQS's: its type, and a string, or binary in base64. */
export interface MessageAttribute {
  dataType: string;
  stringValue?: string;
  binaryValue?: string;
}

/** A message received: as it was sent, with the receipt handle that deletes it until it is received again. */
export interface ReceivedMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: Record<string, MessageAttribute>;
  /** How many times it was received, this time included. */
  receiveCount: number;
  /** Who sent it: an access key, an API key or a user, or a function's ARN for its destination records. */
  senderId: string;
  sentAt: string;
}

/** A received message's fields, as the API's ReceivedMessageView names them: contract.test.ts checks them. */
export const RECEIVED_MESSAGE_FIELDS = ['messageId', 'receiptHandle', 'body', 'attributes', 'receiveCount', 'senderId', 'sentAt'] as const satisfies ReadonlyArray<keyof ReceivedMessage>;

/** The account's queues: every member reads them; owners and developers make, change and delete them, and send and receive to debug them. */
export const queuesApi = {
  list: () => api.get<Queue[]>('/queues'),
  get: (name: string) => api.get<Queue>(`/queues/${name}`),
  create: (name: string, attributes: QueueAttributes = {}) => api.post<Queue>('/queues', { name, ...attributes }),
  update: (name: string, attributes: QueueAttributes) => api.patch<Queue>(`/queues/${name}`, attributes),
  remove: (name: string) => api.delete(`/queues/${name}`),
  purge: (name: string) => api.post(`/queues/${name}/purge`),
  send: (name: string, message: { body: string; delaySeconds?: number; attributes?: Record<string, MessageAttribute> }) =>
    api.post<{ messageId: string; md5OfBody: string }>(`/queues/${name}/messages`, message),
  /** Each message received is hidden for its visibility timeout and its receive counted, as any receive's. */
  receive: (name: string, options: { maxMessages?: number; visibilityTimeout?: number; waitTimeSeconds?: number } = {}) =>
    api.post<ReceivedMessage[]>(`/queues/${name}/receive`, options),
  deleteMessage: (name: string, receiptHandle: string) => api.delete(`/queues/${name}/messages/${encodeURIComponent(receiptHandle)}`),
};

/** The account's alarms: every member reads them; owners and developers change them. */
export const alarmsApi = {
  list: () => api.get<Alarm[]>('/alarms'),
  create: (data: AlarmBody) => api.post<Alarm>('/alarms', data),
  update: (id: string, data: AlarmBody) => api.put<Alarm>(`/alarms/${id}`, data),
  remove: (id: string) => api.delete(`/alarms/${id}`),
};

/** The chosen account's API keys: its owners' only. */
export const apiKeysApi = {
  listKeys: () => api.get<ApiKey[]>('/api-keys'),

  createKey: (data: NewApiKey) => api.post<CreatedApiKey>('/api-keys', data),

  revokeKey: (id: string) => api.delete<ApiKey>(`/api-keys/${id}`),
};

export const getScalingConfig = async (functionId: string): Promise<ScalingConfig> => {
  const response = await api.get<ScalingConfig>(`/functions/${functionId}/scaling-config`);
  return response.data;
};

export const updateScalingConfig = async (functionId: string, limits: Partial<ScalingLimits>): Promise<ScalingConfig> => {
  const response = await api.put<ScalingConfig>(`/functions/${functionId}/scaling-config`, limits);
  return response.data;
};

export default api;

import axios from 'axios';
import { config } from '../config';
import { requestHeaders } from '../lib/session';

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

/** A function, as the API returns it. */
export interface Function {
  id: string;
  name: string;
  /** The account that owns the function (D1). */
  accountId: string;
  runtime: Runtime;
  code: string;
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
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** What POST /functions accepts. */
export type NewFunction = Pick<Function, 'name' | 'runtime' | 'code' | 'memory' | 'timeout'> & {
  metadata?: Record<string, unknown>;
};

/** What PUT /functions/:id accepts: any subset of these. */
export type FunctionUpdate = Partial<Pick<Function, 'name' | 'runtime' | 'code' | 'memory' | 'timeout'>>;

/**
 * Every status an invocation can have: the API's, which contract.test.ts checks.
 * THROTTLED: no instance could take the call in time (P-15). LOST: the backend
 * stopped during the call, so its answer is unknown (P-20). Neither is billed.
 * SUCCESS has been in the database's list from the start, but nothing writes it.
 */
export const INVOCATION_STATUSES = ['SUCCESS', 'ERROR', 'TIMEOUT', 'RUNNING', 'COMPLETED', 'THROTTLED', 'LOST'] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

/** An invocation, as the API returns it: from POST /functions/:id/invoke, and in the history. */
export interface FunctionInvocation {
  id: string;
  functionId: string;
  input: unknown;
  output: unknown;
  status: InvocationStatus;
  /** Milliseconds, as the runtime measured it. */
  duration: number;
  /** MB: the runtime's peak memory. */
  memoryUsed?: number | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One page of GET /functions/:id/invocations, newest first. */
export interface InvocationPage {
  invocations: FunctionInvocation[];
  total: number;
}

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

  /** `input` becomes the handler's event.body. */
  invokeFunction: (id: string, input: Record<string, unknown>) =>
    api.post<FunctionInvocation>(`/functions/${id}/invoke`, { input }),

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

/** GET /usage: one month by the UTC calendar. */
export interface MonthlyUsage {
  /** YYYY-MM */
  month: string;
  /** Each function with calls in the month, the most GB-seconds first, then any that cost something without a call. */
  functions: FunctionUsage[];
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

// Metrics API endpoints
export const getMetrics = async (functionId: string, start: Date, end: Date) => {
  const response = await api.get(`/metrics/${functionId}`, {
    params: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
  });
  return response.data;
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
}

export interface Plan {
  id: string;
  name: string;
  limits: PlanLimits;
}

/** One of the user's accounts, in GET /me. */
export interface MeAccount {
  /** 12 digits. */
  id: string;
  name: string;
  status: AccountStatus;
  /** The user's role in it. */
  role: Role;
  /** Its plan, whose limits the API applies. */
  plan: Plan;
}

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

export const SCOPES = ['functions:read', 'functions:write', 'functions:invoke', 'logs:read', 'metrics:read', 'usage:read'] as const;
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

  /** The new account is pending, and its creator its owner. */
  createAccount: (data: NewAccount) => api.post<Account>('/accounts', data),

  getAccount: (id: string) => api.get<Account>(`/accounts/${id}`),

  updateAccount: (id: string, data: AccountUpdate) => api.patch<Account>(`/accounts/${id}`, data),
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

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

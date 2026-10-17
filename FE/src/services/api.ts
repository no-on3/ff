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

export type InvocationStatus = 'RUNNING' | 'COMPLETED' | 'ERROR' | 'TIMEOUT';

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

/** One of the user's accounts, in GET /me. */
export interface MeAccount {
  /** 12 digits. */
  id: string;
  name: string;
  status: AccountStatus;
  /** The user's role in it. */
  role: Role;
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

import axios from 'axios';
import type { ApiAuth } from './auth/oidc';
import { DEFAULT_API_URL, config } from './config';
import type { AccountSummary, AccountView, StatusChange } from './lib/accounts';
import type { OperatorAction } from './lib/audit';
import type { Plan, PlanLimits } from './lib/plans';
import type { PriceBook, PriceBookPreview, PriceDocument } from './lib/prices';
import type { PlatformSettings } from './lib/settings';

const api = axios.create({
  baseURL: 'apiUrl' in config ? config.apiUrl : DEFAULT_API_URL,
  headers: { 'Content-Type': 'application/json' },
});

let auth: ApiAuth = { accessToken: async () => undefined, onUnauthorized: () => undefined };

/** Called once at start-up, before the first request. */
export function setApiAuth(next: ApiAuth): void {
  auth = next;
}

// Every request carries the operator's token: the admin routes take only ff-admin's (D12).
api.interceptors.request.use(async (request) => {
  const token = await auth.accessToken();
  if (token) request.headers.set('Authorization', `Bearer ${token}`);
  return request;
});

api.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 401) {
    const message = (error.response.data as { message?: unknown } | undefined)?.message;
    auth.onUnauthorized(typeof message === 'string' && message ? message : 'Authentication required');
  }
  return Promise.reject(error);
});

/** GET and PUT /admin/settings. */
export interface SettingsView {
  settings: PlatformSettings;
  defaults: PlatformSettings;
}

/** GET /admin/audit-log: a page of operator actions (P-76). */
export interface OperatorActionPage {
  entries: OperatorAction[];
  /** `before` for the next page, older; null on the last. */
  next: string | null;
}

export const auditApi = {
  page: (params: Record<string, string>) => api.get<OperatorActionPage>('/admin/audit-log', { params }),

  /** The newest 10,000 that match, as CSV; `truncated` when more matched. */
  csv: async (params: Record<string, string>) => {
    const res = await api.get<string>('/admin/audit-log', { params, headers: { Accept: 'text/csv' }, responseType: 'text' });
    return { text: res.data, truncated: res.headers['x-ff-truncated'] === 'true' };
  },
};

/** GET /admin/accounts: a page of accounts (P-71). */
export interface AccountPage {
  accounts: AccountSummary[];
  /** `before` for the next page, older; null on the last. */
  next: string | null;
}

/** An entry of an account's audit log, operators named (GET /admin/accounts/:id/audit-log). */
export interface AccountAuditEntry {
  id: string;
  at: string;
  actor: string;
  actorLabel: string;
  action: string;
  resource: string | null;
  details: Record<string, unknown> | null;
}

const accountPath = (id: string) => `/admin/accounts/${encodeURIComponent(id)}`;

/** The accounts routes (P-71): every change carries the operator's reason, and answers with the account page. */
export const accountsApi = {
  page: (params: Record<string, string>) => api.get<AccountPage>('/admin/accounts', { params }),
  get: (id: string) => api.get<AccountView>(accountPath(id)),
  auditLog: (id: string, params: Record<string, string>) =>
    api.get<{ entries: AccountAuditEntry[]; next: string | null }>(`${accountPath(id)}/audit-log`, { params }),
  change: (id: string, change: StatusChange, reason: string) => api.post<AccountView>(`${accountPath(id)}/${change}`, { reason }),
  plan: (id: string, planId: string, reason: string) => api.put<AccountView>(`${accountPath(id)}/plan`, { planId, reason }),
  egress: (id: string, internetEgress: boolean, reason: string) => api.put<AccountView>(`${accountPath(id)}/egress`, { internetEgress, reason }),
};

export const plansApi = {
  list: () => api.get<Plan[]>('/admin/plans'),
  create: (plan: Plan, reason: string) => api.post<Plan>('/admin/plans', { ...plan, reason }),
  /** The new quota goes to every account on the plan: `quota` counts them. */
  update: (id: string, change: { name?: string; limits: PlanLimits }, reason: string) =>
    api.put<{ plan: Plan; quota: { applied: number; failed: number } }>(`/admin/plans/${encodeURIComponent(id)}`, { ...change, reason }),
};

/** The price books (P-73): a new one starts later; one that has started never changes. */
export const pricesApi = {
  list: () => api.get<PriceBook[]>('/admin/price-books'),
  create: (validFrom: string, document: PriceDocument, reason: string) => api.post<PriceBook>('/admin/price-books', { validFrom, document, reason }),
  /** Last month priced with the draft; nothing is saved, so no reason. */
  preview: (document: PriceDocument) => api.post<PriceBookPreview>('/admin/price-books/preview', { document }),
  remove: (id: string, reason: string) => api.delete(`/admin/price-books/${encodeURIComponent(id)}`, { data: { reason } }),
};

export const settingsApi = {
  get: () => api.get<SettingsView>('/admin/settings'),
  /** Every change carries the operator's reason, which the audit log keeps (D12). */
  update: (settings: Partial<PlatformSettings>, reason: string) => api.put<SettingsView>('/admin/settings', { settings, reason }),
};

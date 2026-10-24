import axios from 'axios';
import type { ApiAuth } from './auth/oidc';
import { DEFAULT_API_URL, config } from './config';
import type { AccountSummary, AccountView, StatusChange } from './lib/accounts';
import type { OperatorAction } from './lib/audit';
import type { Grant, GrantRequest } from './lib/credits';
import type { AdminInvoice, DraftsPage, IssueResult } from './lib/invoices';
import type { Overview } from './lib/overview';
import type { AdminPayment } from './lib/payments';
import { REASON_HEADER } from './lib/reason';
import type { Plan, PlanLimits } from './lib/plans';
import type { PriceBook, PriceBookPreview, PriceDocument } from './lib/prices';
import type { PlatformSettings } from './lib/settings';
import type { CallData, FunctionPage, LogLine, SearchResults } from './lib/support';

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
  /** The account's databases, buckets and queues off, or on again. */
  storage: (id: string, enabled: boolean, reason: string) => api.put<AccountView>(`${accountPath(id)}/storage`, { enabled, reason }),
  /** Credit FF gives (P-74): the grant, and the account page after it. */
  grant: (id: string, request: GrantRequest) => api.post<{ grant: Grant; account: AccountView }>(`${accountPath(id)}/credits`, request),
};

const functionPath = (id: string) => `/admin/functions/${encodeURIComponent(id)}`;

/**
 * Support: the search and a function's page. The code, a call's data and the
 * logs come only for a reason, recorded in the account's audit log.
 */
export const supportApi = {
  search: (q: string) => api.get<SearchResults>('/admin/search', { params: { q } }),
  functionPage: (id: string) => api.get<FunctionPage>(functionPath(id)),
  code: (id: string, reason: string) => api.post<{ runtime: string; code: string }>(`${functionPath(id)}/code`, { reason }),
  call: (id: string, callId: string, reason: string) => api.post<CallData>(`${functionPath(id)}/invocations/${encodeURIComponent(callId)}`, { reason }),
  logs: (id: string, reason: string, request: { sinceSeconds?: number; requestId?: string; cursor?: string }) =>
    api.post<{ lines: LogLine[]; next: string | null }>(`${functionPath(id)}/logs`, { reason, ...request }),
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

/** A transfer as the bank statement shows it, against its pro-forma's reference (P-35). */
export interface TransferEntry {
  reference: string;
  received: string;
  withheld: string;
  /** YYYY-MM-DD, the transfer's date on the statement. */
  receivedOn: string;
  bankReference?: string;
}

/** The payments routes (P-35): every change carries the operator's reason, and answers with the payment. */
export const paymentsApi = {
  page: (params: Record<string, string>) => api.get<{ payments: AdminPayment[]; next: string | null }>('/admin/payments', { params }),
  record: (entry: TransferEntry, reason: string) => api.post<AdminPayment>('/admin/bank-transfers', { ...entry, reason }),
  /** The file is the body, as is; the reason goes in X-FF-Reason, URI-encoded. */
  addCertificate: (id: string, file: Blob, reason: string) =>
    api.put<AdminPayment>(`/admin/payments/${encodeURIComponent(id)}/withholding-certificate`, file, {
      headers: { 'Content-Type': file.type, [REASON_HEADER]: encodeURIComponent(reason) },
    }),
  certificate: (id: string) => api.get<Blob>(`/admin/payments/${encodeURIComponent(id)}/withholding-certificate`, { responseType: 'blob' }),
  /** A pending pro-forma cancelled, with the reason the owners' e-mail gives (P-74). */
  cancel: (id: string, reason: string) => api.post<AdminPayment>(`/admin/payments/${encodeURIComponent(id)}/cancel`, { reason }),
};

/** The invoice routes (P-36): a month's drafts, issuing them with a reason, the issued documents, their PDFs, and credit notes. */
export const invoicesApi = {
  drafts: (month: string) => api.get<DraftsPage>('/admin/invoices/drafts', { params: { month } }),
  /** Every draft of the month, or the accounts named, one after the other. */
  issue: (month: string, accountIds: string[] | undefined, reason: string) => api.post<IssueResult>('/admin/invoices/issue', { month, ...(accountIds ? { accountIds } : {}), reason }),
  page: (params: Record<string, string>) => api.get<{ invoices: AdminInvoice[]; next: string | null }>('/admin/invoices', { params }),
  pdf: (id: string) => api.get<Blob>(`/admin/invoices/${encodeURIComponent(id)}/pdf`, { responseType: 'blob' }),
  /** Lines before tax, each at the invoice's VAT rate. */
  creditNote: (id: string, lines: Array<{ description: string; amount: string }>, reason: string) =>
    api.post<AdminInvoice>(`/admin/invoices/${encodeURIComponent(id)}/credit-notes`, { lines, reason }),
};

export const settingsApi = {
  get: () => api.get<SettingsView>('/admin/settings'),
  /** Every change carries the operator's reason, which the audit log keeps (D12). */
  update: (settings: Partial<PlatformSettings>, reason: string) => api.put<SettingsView>('/admin/settings', { settings, reason }),
};

/** The overview: the platform at a glance, at most a minute old. */
export const statsApi = {
  overview: () => api.get<Overview>('/admin/stats/overview'),
};

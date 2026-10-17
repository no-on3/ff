import axios from 'axios';
import type { ApiAuth } from './auth/oidc';
import { DEFAULT_API_URL, config } from './config';
import type { OperatorAction } from './lib/audit';
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

export const settingsApi = {
  get: () => api.get<SettingsView>('/admin/settings'),
  /** Every change carries the operator's reason, which the audit log keeps (D12). */
  update: (settings: Partial<PlatformSettings>, reason: string) => api.put<SettingsView>('/admin/settings', { settings, reason }),
};

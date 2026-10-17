import type { ErrorContext } from 'react-oidc-context';
import type { AccountStatus, MeAccount, Role } from '../services/api';

/** The headers every API request carries: the user's token, and the account it acts for (X-FF-Account, D4). */
export function requestHeaders(token: string | undefined, accountId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (accountId) headers['X-FF-Account'] = accountId;
  return headers;
}

/** What a role may do in its account (D4): change functions, or also manage the account. */
export type Permission = 'change functions' | 'manage the account';

/** Whether a role may do it, as the API decides (P-12): the console hides what it would refuse. */
export function can(role: Role, permission: Permission): boolean {
  if (permission === 'manage the account') return role === 'owner';
  return role === 'owner' || role === 'developer';
}

/**
 * The account the console acts for: the one chosen last time, if the user
 * still belongs to it; else the first active one; else the first. null when
 * the user has no account yet.
 */
export function chooseAccount(accounts: MeAccount[], remembered: string | null | undefined): MeAccount | null {
  return (
    accounts.find((account) => account.id === remembered) ??
    accounts.find((account) => account.status === 'active') ??
    accounts[0] ??
    null
  );
}

/**
 * What the console shows for the chosen account:
 * - `onboarding`: no account yet, so the form that creates one;
 * - `pending`: the "waiting for approval" page instead of the functions;
 * - `rejected`: why there is nothing to do;
 * - `console`: the functions pages, with a banner when the account can't
 *   change anything (the API refuses those calls, P-12).
 */
export type AccountPage = 'onboarding' | 'pending' | 'rejected' | 'console';

const BANNERS: Partial<Record<AccountStatus, string>> = {
  suspended: 'This account is suspended: you can read and delete its functions, but not create, change or invoke them.',
  closed: 'This account is closed: you can read and delete its functions, but not create, change or invoke them.',
};

export function accountView(account: MeAccount | null): { page: AccountPage; banner?: string } {
  if (!account) return { page: 'onboarding' };
  if (account.status === 'pending') return { page: 'pending' };
  if (account.status === 'rejected') return { page: 'rejected' };
  return { page: 'console', banner: BANNERS[account.status] };
}

/**
 * Where to go after logging in: the page the user was on, from the state the
 * login kept. Only a path on this site, never another address.
 */
export function returnPath(state: unknown): string {
  const path = (state as { returnTo?: unknown } | null | undefined)?.returnTo;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}

/**
 * Why the login page shows again, if there is a reason to say: the login
 * itself failed, or the session ended (the API refused it, or the realm
 * refused to renew it). A failed logout callback isn't worth a word.
 */
export function loginNotice(error: Pick<ErrorContext, 'source' | 'message'> | undefined, refused: string | null): string | null {
  if (error?.source === 'signinCallback' || error?.source === 'signinRedirect') return `Login failed: ${error.message}`;
  if (refused) return refused;
  if (error?.source === 'renewSilent') return 'Your session has ended: log in again.';
  return null;
}

/** Whether an access token expiring at `expiresAt` (seconds since 1970) should be renewed before use. */
export function needsRenewal(expiresAt: number | undefined, nowMs: number, marginSeconds = 30): boolean {
  return expiresAt !== undefined && expiresAt - nowMs / 1000 < marginSeconds;
}

/** Why GET /me failed, with what to do: the console can't show anything without it. */
export function loadErrorMessage(error: unknown, { loginConfigured, apiUrl, origin }: { loginConfigured: boolean; apiUrl: string; origin: string }): string {
  const response = (error as { response?: { status?: number; data?: { message?: unknown } } } | null)?.response;
  if (!response) {
    return `Can't reach the API at ${apiUrl}. Is the backend running, and does its CORS_ORIGIN include ${origin}?`;
  }
  if (response.status === 401 && !loginConfigured) {
    return 'The API asks for a login, but this console has none: set VITE_OIDC_AUTHORITY (see FE/.env.example), or run the API with FF_AUTH_MODE=dev.';
  }
  const message = response.data?.message;
  const reason = Array.isArray(message) ? message.join('; ') : typeof message === 'string' ? message : `HTTP ${response.status}`;
  return `The API refused to load your account: ${reason}`;
}

const ACCOUNT_KEY = 'ff.account';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked, or not in a browser
  }
}

/** The account chosen last time in this browser. */
export function rememberedAccount(store: Storage | null = storage()): string | null {
  try {
    return store?.getItem(ACCOUNT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberAccount(id: string, store: Storage | null = storage()): void {
  try {
    store?.setItem(ACCOUNT_KEY, id);
  } catch {
    // Private windows may refuse: the console then picks the first account each time.
  }
}

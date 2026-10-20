/** Where the admin dashboard finds the API and the login, read at build time from VITE_* variables (admin/.env.example). */
export interface AdminConfig {
  /** The API's address, without a trailing slash. */
  apiUrl: string;
  oidc: {
    /** The realm's issuer URL, e.g. http://localhost:8180/realms/ff. */
    authority: string;
    clientId: string;
  };
  /** Where the operator's Grafana is, for the overview's links to its dashboards; none when unset. */
  grafanaUrl?: string;
}

export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_OIDC_CLIENT_ID = 'ff-admin';

const trimmed = (value: string | undefined) => value?.trim().replace(/\/+$/, '') ?? '';

/**
 * The dashboard's settings from the build's environment. Operators always log
 * in, so a missing realm is a problem to show, not a development mode (P-70).
 */
export function adminConfig(env: Partial<Record<string, string>>): AdminConfig | { problem: string } {
  const authority = trimmed(env.VITE_OIDC_AUTHORITY);
  if (!authority) return { problem: 'VITE_OIDC_AUTHORITY is not set: the admin dashboard needs the realm operators log in with (see admin/.env.example).' };
  const grafanaUrl = trimmed(env.VITE_GRAFANA_URL);
  return {
    apiUrl: trimmed(env.VITE_API_URL) || DEFAULT_API_URL,
    oidc: { authority, clientId: env.VITE_OIDC_CLIENT_ID?.trim() || DEFAULT_OIDC_CLIENT_ID },
    ...(grafanaUrl ? { grafanaUrl } : {}),
  };
}

export const config = adminConfig(import.meta.env);

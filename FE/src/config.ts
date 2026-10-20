/** Where the console finds the API and the login (OIDC), read at build time from VITE_* variables. */
export interface OidcConfig {
  /** The realm's issuer URL, e.g. http://localhost:8180/realms/ff. */
  authority: string;
  clientId: string;
}

export interface ConsoleConfig {
  /** The API's address, without a trailing slash. */
  apiUrl: string;
  /** null is development mode: no login, and the API must run with FF_AUTH_MODE=dev. */
  oidc: OidcConfig | null;
}

export const DEFAULT_API_URL = 'http://localhost:3000';
export const DEFAULT_OIDC_CLIENT_ID = 'ff-console';

const trimmed = (value: string | undefined) => value?.trim().replace(/\/+$/, '') ?? '';

/** The console's settings from the build's environment (FE/.env.example lists them). */
export function consoleConfig(env: Partial<Record<string, string>>): ConsoleConfig {
  const authority = trimmed(env.VITE_OIDC_AUTHORITY);
  return {
    apiUrl: trimmed(env.VITE_API_URL) || DEFAULT_API_URL,
    oidc: authority ? { authority, clientId: env.VITE_OIDC_CLIENT_ID?.trim() || DEFAULT_OIDC_CLIENT_ID } : null,
  };
}

export const config = consoleConfig(import.meta.env);

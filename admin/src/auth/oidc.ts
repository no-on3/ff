import type { UserManager, UserManagerSettings } from 'oidc-client-ts';
import type { AdminConfig } from '../config';

/** Where Keycloak sends the browser back after logging out. */
export const LOGGED_OUT_PATH = '/logged-out';
/** Renew the access token this long before it expires (5 minutes in the development realm). */
const RENEW_BEFORE_SECONDS = 60;

/**
 * The login (D12): the authorization code flow with PKCE, through the ff-admin
 * client, where Keycloak asks operators for a one-time password. Tokens stay
 * in sessionStorage, so the session ends with the tab.
 */
export function oidcSettings(oidc: AdminConfig['oidc'], origin: string): UserManagerSettings {
  return {
    authority: oidc.authority,
    client_id: oidc.clientId,
    redirect_uri: `${origin}/`,
    post_logout_redirect_uri: `${origin}${LOGGED_OUT_PATH}`,
    scope: 'openid profile email',
    automaticSilentRenew: true,
  };
}

/** Whether a token that expires at `expiresAt` (seconds) should be renewed before use, at `now` (ms). */
export function needsRenewal(expiresAt: number | undefined, now: number): boolean {
  return expiresAt === undefined || expiresAt * 1000 - now <= RENEW_BEFORE_SECONDS * 1000;
}

/** What the API client needs from the login. */
export interface ApiAuth {
  /** The access token to send, renewed first when it is about to expire. */
  accessToken(): Promise<string | undefined>;
  /** The API answered 401: the session is over. */
  onUnauthorized(message: string): void;
}

type TokenSource = Pick<UserManager, 'getUser' | 'signinSilent'>;

/** The current access token, renewed once for any number of requests at once; a 401 ends the session. */
export function oidcApiAuth(users: TokenSource, endSession: (message: string) => void, now: () => number = Date.now): ApiAuth {
  let renewal: Promise<string | undefined> | null = null;
  const renew = () => {
    renewal ??= users
      .signinSilent()
      .then(
        (user) => user?.access_token,
        () => undefined,
      )
      .finally(() => {
        renewal = null;
      });
    return renewal;
  };
  return {
    async accessToken() {
      const user = await users.getUser();
      if (!user) return undefined;
      return needsRenewal(user.expires_at, now()) ? renew() : user.access_token;
    },
    onUnauthorized: endSession,
  };
}

import type { UserManager, UserManagerSettings } from 'oidc-client-ts';
import type { OidcConfig } from '../config';
import { needsRenewal } from '../lib/session';
import type { ApiAuth } from '../services/api';

/** Where Keycloak sends the browser back after logging out. */
export const LOGGED_OUT_PATH = '/logged-out';

/**
 * The login's settings: the authorization code flow with PKCE (oidc-client-ts
 * always uses it), back to the console's root, and the access token renewed
 * with the refresh token a minute before it expires (5 minutes in the
 * development realm). Tokens stay in sessionStorage, oidc-client-ts's
 * default, so the session ends with the tab.
 */
export function oidcSettings(oidc: OidcConfig, origin: string): UserManagerSettings {
  return {
    authority: oidc.authority,
    client_id: oidc.clientId,
    redirect_uri: `${origin}/`,
    post_logout_redirect_uri: `${origin}${LOGGED_OUT_PATH}`,
    scope: 'openid profile email',
    automaticSilentRenew: true,
  };
}

type TokenSource = Pick<UserManager, 'getUser' | 'signinSilent'>;

/**
 * The API client's side of the login: the current access token, renewed
 * first when it is about to expire (after the laptop slept, say), with one
 * renewal for any number of requests at once. When the API still answers 401,
 * the session is over, and `endSession` shows the login page.
 */
export function oidcApiAuth(users: TokenSource, endSession: (message: string) => void, now: () => number = Date.now): ApiAuth {
  let renewal: Promise<string | undefined> | null = null;
  const renew = () => {
    renewal ??= users
      .signinSilent()
      .then(
        (user) => user?.access_token,
        () => undefined, // the session ended at the realm: the API's 401 then ends it here
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

import type { User } from 'oidc-client-ts';
import { describe, expect, it, vi } from 'vitest';
import { LOGGED_OUT_PATH, oidcApiAuth, oidcSettings } from './oidc';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const user = (accessToken: string, secondsLeft: number) => ({ access_token: accessToken, expires_at: NOW / 1000 + secondsLeft }) as User;

/** A UserManager that holds `current`, and renews it with `renewed` (or fails). */
function users(current: User | null, renewed: () => Promise<User | null>) {
  return { getUser: vi.fn(async () => current), signinSilent: vi.fn(renewed) };
}

describe('oidcSettings', () => {
  const settings = oidcSettings({ authority: 'http://localhost:8180/realms/ff', clientId: 'ff-console' }, 'http://localhost:5199');

  it("comes back to the console's root after login, and to the logged-out page after logout", () => {
    expect(settings).toMatchObject({
      authority: 'http://localhost:8180/realms/ff',
      client_id: 'ff-console',
      redirect_uri: 'http://localhost:5199/',
      post_logout_redirect_uri: `http://localhost:5199${LOGGED_OUT_PATH}`,
    });
  });

  it('asks for the e-mail address the API needs, and renews tokens on its own', () => {
    expect(settings.scope?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email']));
    expect(settings.automaticSilentRenew).toBe(true);
  });
});

describe('oidcApiAuth', () => {
  it('sends the current token while it has time left, without renewing it', async () => {
    const source = users(user('token-1', 240), async () => user('token-2', 300));

    await expect(oidcApiAuth(source, vi.fn(), () => NOW).accessToken()).resolves.toBe('token-1');
    expect(source.signinSilent).not.toHaveBeenCalled();
  });

  it('renews a token about to expire before sending it', async () => {
    const source = users(user('token-1', 10), async () => user('token-2', 300));

    await expect(oidcApiAuth(source, vi.fn(), () => NOW).accessToken()).resolves.toBe('token-2');
  });

  it('renews once for requests made at the same time', async () => {
    let finish: (renewed: User) => void = () => undefined;
    const source = users(user('token-1', -60), () => new Promise<User>((resolve) => (finish = resolve)));
    const auth = oidcApiAuth(source, vi.fn(), () => NOW);

    const tokens = Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
    await vi.waitFor(() => expect(source.signinSilent).toHaveBeenCalled());
    finish(user('token-2', 300));

    await expect(tokens).resolves.toEqual(['token-2', 'token-2', 'token-2']);
    expect(source.signinSilent).toHaveBeenCalledTimes(1);
  });

  it('renews again the next time a token is about to expire', async () => {
    const source = users(user('token-1', 5), async () => user('token-2', 300));
    const auth = oidcApiAuth(source, vi.fn(), () => NOW);

    await auth.accessToken();
    await auth.accessToken();

    expect(source.signinSilent).toHaveBeenCalledTimes(2);
  });

  it('sends no token when the renewal fails, so the API answers 401 and the session ends', async () => {
    const source = users(user('token-1', -60), async () => {
      throw new Error('Session not active');
    });

    await expect(oidcApiAuth(source, vi.fn(), () => NOW).accessToken()).resolves.toBeUndefined();
  });

  it('sends no token without a logged-in user', async () => {
    const source = users(null, async () => user('token-2', 300));

    await expect(oidcApiAuth(source, vi.fn(), () => NOW).accessToken()).resolves.toBeUndefined();
    expect(source.signinSilent).not.toHaveBeenCalled();
  });

  it("ends the session with the API's reason on a 401", () => {
    const endSession = vi.fn();

    oidcApiAuth(users(null, async () => null), endSession).onUnauthorized('The token has expired');

    expect(endSession).toHaveBeenCalledWith('The token has expired');
  });
});

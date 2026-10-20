import { describe, expect, it, vi } from 'vitest';
import { LOGGED_OUT_PATH, needsRenewal, oidcApiAuth, oidcSettings } from './oidc';

describe('oidcSettings', () => {
  it('logs in through ff-admin, back to the dashboard, and out to the logged-out page', () => {
    expect(oidcSettings({ authority: 'http://localhost:8180/realms/ff', clientId: 'ff-admin' }, 'http://localhost:5198')).toMatchObject({
      client_id: 'ff-admin',
      redirect_uri: 'http://localhost:5198/',
      post_logout_redirect_uri: `http://localhost:5198${LOGGED_OUT_PATH}`,
    });
  });
});

describe('the API client\'s token', () => {
  it('is renewed once for requests at once, when it is about to expire', async () => {
    const now = 1_000_000_000_000;
    const signinSilent = vi.fn(async () => ({ access_token: 'renewed' }));
    const auth = oidcApiAuth({ getUser: async () => ({ access_token: 'old', expires_at: now / 1000 + 30 }), signinSilent } as never, () => {}, () => now);

    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual(['renewed', 'renewed']);
    expect(signinSilent).toHaveBeenCalledTimes(1);
    expect([needsRenewal(now / 1000 + 120, now), needsRenewal(now / 1000 + 60, now)]).toEqual([false, true]);
  });
});

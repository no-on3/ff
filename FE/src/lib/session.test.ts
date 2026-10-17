import { describe, expect, it } from 'vitest';
import type { MeAccount } from '../services/api';
import {
  accountView,
  chooseAccount,
  loadErrorMessage,
  loginNotice,
  needsRenewal,
  rememberAccount,
  rememberedAccount,
  requestHeaders,
  returnPath,
} from './session';

const account = (id: string, status: MeAccount['status'] = 'active'): MeAccount => ({ id, name: `Account ${id}`, status, role: 'owner' });

describe('requestHeaders', () => {
  it("sends the user's token and the account the console acts for", () => {
    expect(requestHeaders('eyJ.token', '123456789012')).toEqual({
      Authorization: 'Bearer eyJ.token',
      'X-FF-Account': '123456789012',
    });
  });

  it('sends the token alone before the user has an account (GET /me, POST /accounts)', () => {
    expect(requestHeaders('eyJ.token', undefined)).toEqual({ Authorization: 'Bearer eyJ.token' });
  });

  it('sends neither in development mode, where the API reads no token', () => {
    expect(requestHeaders(undefined, undefined)).toEqual({});
  });
});

describe('chooseAccount', () => {
  const pending = account('100000000001', 'pending');
  const active = account('100000000002');
  const other = account('100000000003');

  it('acts for the account chosen last time', () => {
    expect(chooseAccount([pending, active, other], other.id)).toBe(other);
    expect(chooseAccount([pending, active, other], pending.id)).toBe(pending);
  });

  it('forgets a remembered account the user no longer belongs to, and picks the first active one', () => {
    expect(chooseAccount([pending, active, other], '999999999999')).toBe(active);
    expect(chooseAccount([pending, active], null)).toBe(active);
  });

  it('picks the first account when none is active, and none when the user has no account yet', () => {
    expect(chooseAccount([pending, account('100000000004', 'rejected')], null)).toBe(pending);
    expect(chooseAccount([], '100000000001')).toBeNull();
  });
});

describe('accountView', () => {
  it('asks a user without an account to create one', () => {
    expect(accountView(null)).toEqual({ page: 'onboarding' });
  });

  it("shows a pending account the page that says it waits for approval, instead of functions it can't deploy", () => {
    expect(accountView(account('100000000001', 'pending'))).toEqual({ page: 'pending' });
  });

  it('shows a rejected account why there is nothing to do', () => {
    expect(accountView(account('100000000001', 'rejected'))).toEqual({ page: 'rejected' });
  });

  it('shows an active account its functions, without a banner', () => {
    expect(accountView(account('100000000001'))).toEqual({ page: 'console', banner: undefined });
  });

  it('shows a suspended or closed account its functions, with what the API still allows', () => {
    for (const status of ['suspended', 'closed'] as const) {
      const view = accountView(account('100000000001', status));
      expect(view.page).toBe('console');
      expect(view.banner).toMatch(new RegExp(`^This account is ${status}: you can read and delete its functions, but not create, change or invoke them\\.$`));
    }
  });
});

describe('returnPath', () => {
  it('goes back to the page the user was on, with its query', () => {
    expect(returnPath({ returnTo: '/functions/3f9c?tab=history' })).toBe('/functions/3f9c?tab=history');
  });

  it('goes home without a state', () => {
    expect(returnPath(undefined)).toBe('/');
    expect(returnPath(null)).toBe('/');
    expect(returnPath({})).toBe('/');
    expect(returnPath('/functions')).toBe('/');
  });

  it('never goes to another site', () => {
    for (const returnTo of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', 42]) {
      expect(returnPath({ returnTo })).toBe('/');
    }
  });
});

describe('loginNotice', () => {
  const refused = 'The API refused your session (Authentication required): log in again.';

  it("says the login failed, with the realm's reason", () => {
    expect(loginNotice({ source: 'signinCallback', message: 'No matching state found in storage' }, null)).toBe(
      'Login failed: No matching state found in storage',
    );
    expect(loginNotice({ source: 'signinRedirect', message: 'Failed to fetch' }, refused)).toBe('Login failed: Failed to fetch');
  });

  it("says why the session ended: the API's refusal first, as it names the reason", () => {
    expect(loginNotice({ source: 'renewSilent', message: 'Session not active' }, refused)).toBe(refused);
    expect(loginNotice(undefined, refused)).toBe(refused);
  });

  it("says the session ended when the realm refused to renew it, rather than 'login failed'", () => {
    expect(loginNotice({ source: 'renewSilent', message: 'Session not active' }, null)).toBe('Your session has ended: log in again.');
  });

  it('says nothing on a first visit, or after a logout', () => {
    expect(loginNotice(undefined, null)).toBeNull();
    expect(loginNotice({ source: 'signoutCallback', message: 'No matching state found in storage' }, null)).toBeNull();
  });
});

describe('needsRenewal', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');
  const inSeconds = (s: number) => now / 1000 + s;

  it('keeps a token with more than 30 seconds left', () => {
    expect(needsRenewal(inSeconds(31), now)).toBe(false);
  });

  it('renews a token about to expire, or expired already (after the laptop slept)', () => {
    expect(needsRenewal(inSeconds(29), now)).toBe(true);
    expect(needsRenewal(inSeconds(-3600), now)).toBe(true);
  });

  it("can't tell without an expiry, so keeps the token: the API's 401 then ends the session", () => {
    expect(needsRenewal(undefined, now)).toBe(false);
  });
});

describe('loadErrorMessage', () => {
  const where = { loginConfigured: true, apiUrl: 'http://localhost:3000', origin: 'http://localhost:5199' };
  const answer = (status: number, data: unknown) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  it("says the API can't be reached, and what to check, when there is no answer", () => {
    expect(loadErrorMessage(new Error('Network Error'), where)).toBe(
      "Can't reach the API at http://localhost:3000. Is the backend running, and does its CORS_ORIGIN include http://localhost:5199?",
    );
  });

  it('says what to set when the API wants a login and the console has none', () => {
    expect(loadErrorMessage(answer(401, { message: 'Authentication required' }), { ...where, loginConfigured: false })).toBe(
      'The API asks for a login, but this console has none: set VITE_OIDC_AUTHORITY (see FE/.env.example), or run the API with FF_AUTH_MODE=dev.',
    );
  });

  it("gives the API's own reason otherwise", () => {
    expect(loadErrorMessage(answer(403, { message: 'The e-mail address is not verified' }), where)).toBe(
      'The API refused to load your account: The e-mail address is not verified',
    );
    expect(loadErrorMessage(answer(500, {}), where)).toBe('The API refused to load your account: HTTP 500');
  });
});

describe('the remembered account', () => {
  const memory = (): Storage => {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    } as Storage;
  };

  it('is kept in this browser for the next visit', () => {
    const store = memory();
    expect(rememberedAccount(store)).toBeNull();

    rememberAccount('123456789012', store);

    expect(rememberedAccount(store)).toBe('123456789012');
  });

  it("is simply forgotten where the browser refuses storage, as private windows may", () => {
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;

    expect(() => rememberAccount('123456789012', refusing)).not.toThrow();
    expect(rememberedAccount(refusing)).toBeNull();
    expect(rememberedAccount(null)).toBeNull();
  });
});

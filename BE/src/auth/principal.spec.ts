import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { devAccountId, Principal, resolvePrincipal } from './principal';

describe('resolvePrincipal (P-10)', () => {
  const request = (headers: Record<string, string | string[]> = {}, principal?: Principal) => ({ headers, principal });

  it("uses the principal that the guard set, whatever the development settings", () => {
    const fromGuard: Principal = { accountId: '123456789012', userId: 'kc-7', role: 'developer' };

    expect(resolvePrincipal(request({ 'x-ff-dev-account': '999999999999' }, fromGuard), '000000000001')).toBe(fromGuard);
  });

  it("acts as the development account's owner when there is no principal", () => {
    expect(resolvePrincipal(request(), '000000000001')).toEqual({ accountId: '000000000001', userId: 'dev', role: 'owner' });
  });

  it('acts as the account that X-FF-Dev-Account names, to test isolation', () => {
    expect(resolvePrincipal(request({ 'x-ff-dev-account': '000000000002' }), '000000000001')).toMatchObject({
      accountId: '000000000002',
      role: 'owner',
    });
  });

  it.each([['an empty value', ''], ['too few digits', '12345'], ['a letter', '00000000000a'], ['the header twice', ['000000000002', '000000000003']]])(
    'refuses X-FF-Dev-Account with %s',
    (_label, value) => {
      expect(() => resolvePrincipal(request({ 'x-ff-dev-account': value }), '000000000001')).toThrow(BadRequestException);
    },
  );

  it('refuses every request without a principal outside development mode, X-FF-Dev-Account included', () => {
    expect(() => resolvePrincipal(request(), undefined)).toThrow(UnauthorizedException);
    expect(() => resolvePrincipal(request({ 'x-ff-dev-account': '000000000002' }), undefined)).toThrow(UnauthorizedException);
  });
});

describe('devAccountId', () => {
  it('is FF_DEV_ACCOUNT_ID in development mode', () => {
    expect(devAccountId({ FF_AUTH_MODE: 'dev', FF_DEV_ACCOUNT_ID: '000000000001' })).toBe('000000000001');
    expect(devAccountId({ FF_AUTH_MODE: ' dev ', FF_DEV_ACCOUNT_ID: ' 000000000001 ' })).toBe('000000000001');
  });

  it.each([
    ['in oidc mode', { FF_AUTH_MODE: 'oidc', FF_DEV_ACCOUNT_ID: '000000000001' }],
    ['when the mode is unset (oidc is the default)', { FF_DEV_ACCOUNT_ID: '000000000001' }],
    ['from the old FF_DEV_USER_ID, which is no longer read', { FF_DEV_USER_ID: '1' }],
    ['when the account is empty', { FF_AUTH_MODE: 'dev', FF_DEV_ACCOUNT_ID: '' }],
  ])('is nothing %s', (_label, env) => {
    expect(devAccountId(env)).toBeUndefined();
  });
});

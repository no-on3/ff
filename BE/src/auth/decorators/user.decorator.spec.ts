import { UnauthorizedException } from '@nestjs/common';
import { devAccountId, resolveTenantId } from './user.decorator';

describe('resolveTenantId', () => {
  it('uses the authenticated user (an authentication guard stores the token subject)', () => {
    expect(resolveTenantId('kc|abc', '000000000001')).toBe('kc|abc');
  });

  it('accepts a JWT payload object with a subject', () => {
    expect(resolveTenantId({ sub: 'user-7' }, undefined)).toBe('user-7');
    expect(resolveTenantId({ sub: 42 }, undefined)).toBe('42');
  });

  it('never makes a tenant of a subject that is not a string or a number (it would be "[object Object]")', () => {
    expect(() => resolveTenantId({ sub: { id: 'user-7' } }, undefined)).toThrow(UnauthorizedException);
    expect(() => resolveTenantId({ sub: '' }, undefined)).toThrow(UnauthorizedException);
  });

  it('falls back to the development account when nobody is authenticated', () => {
    expect(resolveTenantId(undefined, '000000000001')).toBe('000000000001');
  });

  it.each([
    ['no user and no development account', undefined],
    ['an empty development account', ''],
  ])('rejects the request with %s', (_label, account) => {
    expect(() => resolveTenantId(undefined, account)).toThrow(UnauthorizedException);
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

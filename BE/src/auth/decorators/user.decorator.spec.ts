import { UnauthorizedException } from '@nestjs/common';
import { resolveUserId } from './user.decorator';

describe('resolveUserId', () => {
  it('uses the authenticated user (JwtStrategy stores the token subject)', () => {
    expect(resolveUserId('auth0|abc', 'dev')).toBe('auth0|abc');
  });

  it('accepts a JWT payload object with a subject', () => {
    expect(resolveUserId({ sub: 'user-7' }, undefined)).toBe('user-7');
  });

  it('falls back to FF_DEV_USER_ID when nobody is authenticated', () => {
    expect(resolveUserId(undefined, '1')).toBe('1');
  });

  it.each([
    ['no user and no dev fallback', undefined],
    ['an empty dev fallback', ''],
  ])('rejects the request with %s', (_label, devUserId) => {
    expect(() => resolveUserId(undefined, devUserId)).toThrow(UnauthorizedException);
  });
});

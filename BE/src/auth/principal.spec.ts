import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal, resolvePrincipal } from './principal';

describe('resolvePrincipal (P-10, P-12)', () => {
  const principal: Principal = {
    accountId: '123456789012',
    accountStatus: AccountStatus.ACTIVE,
    planId: 'beta',
    userId: 'u-7',
    role: 'developer',
  };

  it('is the principal that the guard resolved', () => {
    expect(resolvePrincipal({ headers: {}, principal })).toBe(principal);
  });

  it("answers with the guard's reason when it couldn't resolve one: no account, or several to choose from", () => {
    const none = new ForbiddenException('This user has no account yet: create one with POST /accounts');
    const several = new BadRequestException('This user belongs to several accounts: name one in the X-FF-Account header');

    expect(() => resolvePrincipal({ headers: {}, principalProblem: none })).toThrow(none);
    expect(() => resolvePrincipal({ headers: {}, principalProblem: several })).toThrow(several);
  });

  it('answers 401 to anyone else', () => {
    expect(() => resolvePrincipal({ headers: {} })).toThrow(UnauthorizedException);
  });
});

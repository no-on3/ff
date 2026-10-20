/**
 * L1: who may call the members routes (client-readiness plan, P-16, D4), as
 * the routes declare it for the global guard: owners only, and never an API
 * key, since no route names a scope.
 */
import { Reflector } from '@nestjs/core';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { MembersController } from './members.controller';

const reflector = new Reflector();

describe('MembersController route rules (L1, P-16)', () => {
  const handlers = Object.getOwnPropertyNames(MembersController.prototype).filter((name) => name !== 'constructor') as Array<
    keyof MembersController
  >;

  it('has the five routes: list, invite, cancel an invitation, change a role, remove', () => {
    expect(handlers.sort()).toEqual(['cancelInvitation', 'changeRole', 'invite', 'list', 'remove']);
  });

  it.each(handlers)("%s: the account's owners only, with a user's token: no scope, so no API key", (handler) => {
    const method = MembersController.prototype[handler];

    expect(reflector.get(ROLES, method)).toEqual(['owner']);
    expect(reflector.get(SCOPE, method)).toBeUndefined();
    expect(reflector.get(ACTIVE_ACCOUNT, method)).toBeUndefined(); // a pending account can gather its team
  });
});

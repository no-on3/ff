/**
 * L1: who may call each function route (client-readiness plan, P-12, D4), as
 * the routes declare it for the global guard: writers (owners and developers)
 * change and invoke functions, viewers only read, and an account deploys and
 * invokes only once it is approved.
 */
import { Reflector } from '@nestjs/core';
import { ACTIVE_ACCOUNT, ROLES } from '../auth/route-rules';
import { FunctionsController } from './functions.controller';

const reflector = new Reflector();
const rules = (handler: keyof FunctionsController) => {
  const method = FunctionsController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
  };
};

describe('FunctionsController route rules (L1, P-12)', () => {
  it.each<[keyof FunctionsController, string]>([
    ['create', 'POST /functions'],
    ['update', 'PUT /functions/:id'],
    ['invoke', 'POST /functions/:id/invoke'],
    ['updateScalingConfig', 'PUT /functions/:id/scaling-config'],
  ])('%s (%s): writers only, and an approved account', (handler) => {
    expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: true });
  });

  it('lets writers delete, even in an account that is not active: deleting frees what it holds', () => {
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false });
  });

  it.each<keyof FunctionsController>(['findAll', 'findOne', 'getInvocations', 'getScalingConfig'])(
    '%s: every member reads, viewers included',
    (handler) => {
      expect(rules(handler)).toEqual({ roles: 'anyone', activeAccount: false });
    },
  );
});

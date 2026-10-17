/**
 * L1: who may call each function route (client-readiness plan, P-12, D4), as
 * the routes declare it for the global guard: writers (owners and developers)
 * change and invoke functions, viewers only read, and an account deploys and
 * invokes only once it is approved.
 */
import { Reflector } from '@nestjs/core';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { INVOCATION } from '../plans/rate-limits';
import { FunctionsController } from './functions.controller';

const reflector = new Reflector();
const rules = (handler: keyof FunctionsController) => {
  const method = FunctionsController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};

describe('FunctionsController route rules (L1, P-12, P-13)', () => {
  it.each<[keyof FunctionsController, string, string]>([
    ['create', 'POST /functions', 'functions:write'],
    ['update', 'PUT /functions/:id', 'functions:write'],
    ['invoke', 'POST /functions/:id/invoke', 'functions:invoke'],
    ['updateScalingConfig', 'PUT /functions/:id/scaling-config', 'functions:write'],
  ])('%s (%s): writers only, an approved account, and a key with %s', (handler, _route, scope) => {
    expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope });
  });

  it('lets writers delete, even in an account that is not active: deleting frees what it holds', () => {
    expect(rules('remove')).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' });
  });

  it.each<keyof FunctionsController>(['findAll', 'findOne', 'getInvocations', 'getScalingConfig'])(
    '%s: every member reads, viewers included, and a key with functions:read',
    (handler) => {
      expect(rules(handler)).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
    },
  );

  it("counts only invoke against the plan's invocation rate; every other change counts against its rate of changes (P-15)", () => {
    const handlers = Object.getOwnPropertyNames(FunctionsController.prototype).filter((name) => name !== 'constructor');
    const invocations = handlers.filter((name) =>
      reflector.get<boolean>(INVOCATION, FunctionsController.prototype[name as keyof FunctionsController]),
    );

    expect(invocations).toEqual(['invoke']);
  });
});

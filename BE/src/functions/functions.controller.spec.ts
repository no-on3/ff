/**
 * L1: who may call each function route (client-readiness plan, P-12, D4), as
 * the routes declare it for the global guard: writers (owners and developers)
 * change and invoke functions, viewers only read, and an account deploys and
 * invokes only once it is approved. The logs route through HTTP (P-40).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { INVOCATION } from '../plans/rate-limits';
import { FunctionsController } from './functions.controller';
import { FunctionsService } from './functions.service';

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

  it('logs: every member reads them, viewers included, and a key with logs:read (P-40)', () => {
    expect(rules('logs')).toEqual({ roles: 'anyone', activeAccount: false, scope: 'logs:read' });
  });

  it("counts only invoke against the plan's invocation rate; every other change counts against its rate of changes (P-15)", () => {
    const handlers = Object.getOwnPropertyNames(FunctionsController.prototype).filter((name) => name !== 'constructor');
    const invocations = handlers.filter((name) =>
      reflector.get<boolean>(INVOCATION, FunctionsController.prototype[name as keyof FunctionsController]),
    );

    expect(invocations).toEqual(['invoke']);
  });
});

describe('GET /functions/:id/logs (L1, P-40, P-43)', () => {
  const ACCOUNT = '000000000001';
  const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
  const LOGS = { lines: [{ time: '2026-10-17T10:00:00.000000000Z', instance: 'fn-a', requestId: null, stream: 'stdout', message: 'hi' }], next: 'older' };
  const functions = { logs: jest.fn(async () => LOGS) };
  let app: INestApplication;
  let baseUrl: string;
  const get = (query: string) => fetch(`${baseUrl}/functions/${ID}/logs${query}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [FunctionsController], providers: [{ provide: FunctionsService, useValue: functions }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'viewer' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("gives the caller's account's function's page, the service choosing the defaults", async () => {
    const res = await get('');

    expect([res.status, await res.json()]).toEqual([200, LOGS]);
    expect(functions.logs).toHaveBeenCalledWith(ACCOUNT, ID, {});
  });

  it("passes `ff logs`'s tail and window on, as numbers", async () => {
    await get('?tail=1000&sinceSeconds=2592000');

    expect(functions.logs).toHaveBeenCalledWith(ACCOUNT, ID, { tail: 1000, sinceSeconds: 2592000 });
  });

  it("passes the store's parameters on: the page's size, the window, the phrase, the call and the cursor", async () => {
    const callId = '0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f';
    await get(`?limit=50&start=2026-10-17T10:00:00Z&end=2026-10-17T11:00:00.5%2B01:00&q=${encodeURIComponent('a "time out"')}&requestId=${callId}&cursor=eyJiIjoiMjAyNi0xMC0xN1QxMDowMDowMloiLCJzIjoxfQ`);

    expect(functions.logs).toHaveBeenCalledWith(ACCOUNT, ID, {
      limit: 50,
      start: '2026-10-17T10:00:00Z',
      end: '2026-10-17T11:00:00.5+01:00',
      q: 'a "time out"',
      requestId: callId,
      cursor: 'eyJiIjoiMjAyNi0xMC0xN1QxMDowMDowMloiLCJzIjoxfQ',
    });
  });

  it.each([
    ['?tail=0', 'tail must not be less than 1'],
    ['?tail=1001', 'tail must not be greater than 1000'],
    ['?tail=many', 'tail must be an integer number'],
    ['?limit=0', 'limit must not be less than 1'],
    ['?limit=1001', 'limit must not be greater than 1000'],
    ['?sinceSeconds=0', 'sinceSeconds must not be less than 1'],
    ['?sinceSeconds=2592001', 'sinceSeconds must not be greater than 2592000'],
    ['?start=2026-10-17', 'start must be an RFC 3339 time, such as 2026-10-17T10:00:00Z'],
    ['?end=yesterday', 'end must be an RFC 3339 time, such as 2026-10-17T11:00:00Z'],
    [`?q=${'x'.repeat(501)}`, 'q must be shorter than or equal to 500 characters'],
    ['?q=%20%20', 'q must have a character other than a space'],
    ['?requestId=req-1', 'requestId must be a UUID'],
    ['?cursor=a%20b', 'cursor must be the next value of the page before'],
    ['?follow=true', 'property follow should not exist'],
  ])('refuses %s', async (query, message) => {
    const res = await get(query);

    expect([res.status, (await res.json()).message]).toEqual([400, expect.arrayContaining([message])]);
    expect(functions.logs).not.toHaveBeenCalled();
  });

  it('refuses an ID that is not one', async () => {
    expect((await fetch(`${baseUrl}/functions/fn-1/logs`)).status).toBe(400);
    expect(functions.logs).not.toHaveBeenCalled();
  });
});

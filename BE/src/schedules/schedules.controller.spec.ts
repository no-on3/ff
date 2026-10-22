/**
 * L1: who may call each schedules route, as the routes declare it for the
 * global guard, and what the validation lets through.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { ScheduleRunsController, SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

const reflector = new Reflector();
const rules = (method: (...args: never[]) => unknown) => ({
  roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
  activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
  scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
});

describe('SchedulesController route rules (L1)', () => {
  it.each<keyof SchedulesController>(['create', 'update'])('%s: writers only, in an approved account, and a key with functions:write', (handler) => {
    expect(rules(SchedulesController.prototype[handler])).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope: 'functions:write' });
  });

  it('lets writers delete a schedule, even in an account that is not active: it stops runs', () => {
    expect(rules(SchedulesController.prototype.remove)).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'functions:write' });
  });

  it.each<keyof SchedulesController>(['list', 'get'])('%s: every member reads them, and a key with functions:read', (handler) => {
    expect(rules(SchedulesController.prototype[handler])).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
  });

  it("previews an expression's runs for every member, and a key with functions:read", () => {
    expect(rules(ScheduleRunsController.prototype.nextRuns)).toEqual({ roles: 'anyone', activeAccount: false, scope: 'functions:read' });
  });
});

describe('POST /functions/:id/schedules, validated (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const schedules = { create: jest.fn(async () => ({})) };
  const ID = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [SchedulesController], providers: [{ provide: SchedulesService, useValue: schedules }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = { accountId: '123456789012', accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'owner' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  const send = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/functions/${ID}/schedules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, message: ((await res.json()) as { message?: string[] }).message };
  };

  it("takes SAM's Schedule fields: a name, an expression, an input of any JSON, a description, enabled", async () => {
    const body = { name: 'nightly.report_v2', expression: 'cron(0 2 * * ? *)', input: [1, 'two'], description: 'The night report', enabled: false };

    expect((await send(body)).status).toBe(201);
    expect(schedules.create).toHaveBeenLastCalledWith('123456789012', ID, body);
  });

  it.each([
    ['no name', { expression: 'rate(1 hour)' }, 'name must be letters, digits'],
    ["a name EventBridge wouldn't take", { name: 'my schedule', expression: 'rate(1 hour)' }, "name must be letters, digits, '.', '-' and '_', as an EventBridge rule's"],
    ['a name of 65 characters', { name: 'n'.repeat(65), expression: 'rate(1 hour)' }, 'name must be shorter than or equal to 64 characters'],
    ['no expression', { name: 'x' }, 'expression must be a string'],
    ['a field SAM has not', { name: 'x', expression: 'rate(1 hour)', state: 'ENABLED' }, 'property state should not exist'],
  ])('refuses %s', async (_case, body, message) => {
    const answer = await send(body);

    expect(answer.status).toBe(400);
    expect(answer.message?.join(' ')).toContain(message);
  });
});

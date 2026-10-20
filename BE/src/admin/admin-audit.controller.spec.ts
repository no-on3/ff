/**
 * L1: GET /admin/audit-log (client-readiness plan, P-76) through HTTP, with
 * the validation main.ts sets up: the filters it passes on, a page of
 * operator actions, and the CSV export. Its SQL runs against PostgreSQL in
 * admin-audit.db.spec.ts; who may call it is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { AdminAuditController } from './admin-audit.controller';
import { IS_ADMIN } from './operator';

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry =>
  ({
    id: '42',
    at: new Date('2026-10-17T10:00:00Z'),
    accountId: null,
    actor: 'operator:kc-op-1',
    actorLabel: 'operator@ff.test',
    action: 'settings.update',
    resource: 'settings',
    ip: '10.0.0.7',
    requestId: '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60',
    details: { reason: 'Pilot customers asked for more time', changes: { gracePeriodHours: { from: 24, to: 48 } } },
    ...overrides,
  });

describe('GET /admin/audit-log (L1, P-76)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const audit = {
    operatorActions: jest.fn(async () => ({ entries: [entry()], next: '41' })),
    operatorActionsForExport: jest.fn(async () => ({ entries: [entry()], truncated: false })),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAuditController],
      providers: [{ provide: AuditService, useValue: audit }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("is one of the admin dashboard's routes: operators only", () => {
    expect(new Reflector().get(IS_ADMIN, AdminAuditController)).toBe(true);
  });

  it('gives a page of operator actions: who, when, what, on which account, and why', async () => {
    const res = await fetch(`${baseUrl}/admin/audit-log`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        {
          id: '42',
          at: '2026-10-17T10:00:00.000Z',
          operator: { id: 'kc-op-1', email: 'operator@ff.test' },
          action: 'settings.update',
          accountId: null,
          resource: 'settings',
          reason: 'Pilot customers asked for more time',
          details: { reason: 'Pilot customers asked for more time', changes: { gracePeriodHours: { from: 24, to: 48 } } },
          ip: '10.0.0.7',
          requestId: '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60',
        },
      ],
      next: '41',
    });
    expect(audit.operatorActions).toHaveBeenCalledWith(
      { operator: undefined, accountId: undefined, action: undefined, from: undefined, to: undefined },
      { limit: 50, before: undefined },
    );
  });

  it('passes the filters and the page on: the operator trimmed, the dates as instants', async () => {
    const query = 'operator=%20OPERATOR@%20&accountId=000000000001&action=account.approve&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&limit=10&before=41';

    expect((await fetch(`${baseUrl}/admin/audit-log?${query}`)).status).toBe(200);
    expect(audit.operatorActions).toHaveBeenCalledWith(
      {
        operator: 'OPERATOR@',
        accountId: '000000000001',
        action: 'account.approve',
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-11-01T00:00:00Z'),
      },
      { limit: 10, before: '41' },
    );
  });

  it.each([
    ['accountId=12345', 'accountId must be an account ID: 12 digits'],
    ['action=DROP', 'action must be an action, such as settings.update'],
    ['from=yesterday', 'from must be a valid ISO 8601 date string'],
    ['limit=101', 'limit must not be greater than 100'],
    ['before=4%3B1', 'before must be a number string'],
  ])('refuses %s: %s', async (query, message) => {
    const res = await fetch(`${baseUrl}/admin/audit-log?${query}`);

    expect([res.status, (await res.json()).message]).toEqual([400, [message]]);
    expect(audit.operatorActions).not.toHaveBeenCalled();
  });

  it('exports CSV for Accept: text/csv: a line each, the details as JSON, free text kept from spreadsheets', async () => {
    audit.operatorActionsForExport.mockResolvedValueOnce({
      entries: [entry({ details: { reason: '=cmd|"/c calc"!A1' }, accountId: '000000000001', action: 'account.suspend', resource: 'account:000000000001' })],
      truncated: false,
    });

    const res = await fetch(`${baseUrl}/admin/audit-log?action=account.suspend`, { headers: { accept: 'text/csv' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ff-operator-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('x-ff-truncated')).toBeNull();
    expect(await res.text()).toBe(
      'at,operator_id,operator_email,action,account_id,resource,reason,ip,request_id,details\r\n' +
        `2026-10-17T10:00:00.000Z,kc-op-1,operator@ff.test,account.suspend,000000000001,account:000000000001,"'=cmd|""/c calc""!A1",10.0.0.7,7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60,"{""reason"":""=cmd|\\""/c calc\\""!A1""}"\r\n`,
    );
    expect(audit.operatorActionsForExport).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.suspend' }), 10_000);
  });

  it('says when the export holds only the newest of what matched', async () => {
    audit.operatorActionsForExport.mockResolvedValueOnce({ entries: [], truncated: true });

    const res = await fetch(`${baseUrl}/admin/audit-log`, { headers: { accept: 'text/csv' } });

    expect(res.headers.get('x-ff-truncated')).toBe('true');
  });
});

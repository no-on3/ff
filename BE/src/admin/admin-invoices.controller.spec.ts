/**
 * L1: the admin invoice routes (client-readiness plan, P-36) through HTTP,
 * with the validation main.ts sets up: what each passes on, and what each
 * refuses. The service runs against PostgreSQL in invoices.db.spec.ts; who
 * may call them is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { InvoicesService } from '../billing/invoices/invoices.service';
import { AdminInvoicesController } from './admin-invoices.controller';
import { IS_ADMIN, Operator } from './operator';

const OPERATOR: Operator = { id: 'kc-op-1', email: 'operator@ff.test' };
const INVOICE = '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60';
const PDF = Buffer.from('%PDF-1.3\n% an invoice\n');

describe('the admin invoice routes (L1, P-36)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const invoices = {
    drafts: jest.fn(async (month: string) => ({ month, issuable: true, drafts: [] })),
    issueAll: jest.fn(async () => ({ issued: [], failed: [] })),
    forOperators: jest.fn(async () => ({ invoices: [], next: null })),
    pdf: jest.fn(async () => ({ body: PDF, number: 'AV-2026-000002' })),
    creditNote: jest.fn(async () => ({ id: INVOICE })),
  };
  const json = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AdminInvoicesController], providers: [{ provide: InvoicesService, useValue: invoices }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { operator?: Operator }, _res: unknown, next: () => void) => {
      req.operator = OPERATOR;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('are admin routes, every one', () => {
    expect(new Reflector().get(IS_ADMIN, AdminInvoicesController)).toBe(true);
  });

  it("give a month's drafts, last month by default, and refuse a month that is not one", async () => {
    expect((await json('GET', '/admin/invoices/drafts?month=2026-10')).status).toBe(200);
    expect((await json('GET', '/admin/invoices/drafts')).status).toBe(200);
    expect(invoices.drafts.mock.calls).toEqual([['2026-10'], [InvoicesService.lastMonth()]]);
    expect(await refusal(await json('GET', '/admin/invoices/drafts?month=2026-13'))).toEqual([400, ['month must be a month, such as 2026-10']]);
  });

  it("issue a month's invoices, every draft or the accounts named, with the reason", async () => {
    expect((await json('POST', '/admin/invoices/issue', { month: '2026-10', reason: 'October, reviewed' })).status).toBe(200);
    expect((await json('POST', '/admin/invoices/issue', { month: '2026-10', accountIds: ['000000000001'], reason: 'One, reviewed' })).status).toBe(200);
    expect(invoices.issueAll.mock.calls).toEqual([
      ['2026-10', undefined, 'October, reviewed'],
      ['2026-10', ['000000000001'], 'One, reviewed'],
    ]);
    expect(await refusal(await json('POST', '/admin/invoices/issue', { month: 'October', reason: 'x'.repeat(5) }))).toEqual([400, ['month must be a month, such as 2026-10']]);
    expect(await refusal(await json('POST', '/admin/invoices/issue', { month: '2026-10', accountIds: ['1'], reason: 'x'.repeat(5) }))).toEqual([
      400,
      ['each of accountIds must be an account ID: 12 digits'],
    ]);
    expect(invoices.issueAll).toHaveBeenCalledTimes(2);
  });

  it('list the issued documents, filtered and a page at a time, and refuse a filter that is not one', async () => {
    expect((await json('GET', '/admin/invoices?accountId=000000000001&kind=credit_note&month=2026-10&limit=10')).status).toBe(200);
    expect(invoices.forOperators).toHaveBeenCalledWith({ accountId: '000000000001', kind: 'credit_note', month: '2026-10' }, { limit: 10, before: undefined });
    expect(await refusal(await json('GET', '/admin/invoices?kind=draft'))).toEqual([400, ['kind must be one of: invoice, credit_note']]);
    expect(await refusal(await json('GET', '/admin/invoices?before=yesterday'))).toEqual([400, ["before must be the previous page's next"]]);
  });

  it("send any account's document, as it was issued", async () => {
    const res = await fetch(`${baseUrl}/admin/invoices/${INVOICE}/pdf`);

    expect([res.status, res.headers.get('content-disposition')]).toEqual([200, 'attachment; filename="AV-2026-000002.pdf"']);
    expect(invoices.pdf).toHaveBeenCalledWith(INVOICE, null);
  });

  it('issue a credit note line by line, with the reason, and refuse lines that are not ones', async () => {
    const lines = [{ description: 'Remboursement du crédit non consommé', amount: '20.000' }, { description: 'Correction', amount: '1', vatPercent: 19 }];

    expect((await json('POST', `/admin/invoices/${INVOICE}/credit-notes`, { lines, reason: 'Unused credit refunded' })).status).toBe(201);
    expect(invoices.creditNote).toHaveBeenCalledWith(INVOICE, lines, 'Unused credit refunded');
    expect(await refusal(await json('POST', `/admin/invoices/${INVOICE}/credit-notes`, { lines: [{ description: 'Refund', amount: '20,000' }], reason: 'x'.repeat(5) }))).toEqual([
      400,
      ['lines.0.amount must be an amount, such as 20.000'],
    ]);
    expect((await json('POST', `/admin/invoices/${INVOICE}/credit-notes`, { lines: [], reason: 'x'.repeat(5) })).status).toBe(400);
    expect((await json('POST', `/admin/invoices/${INVOICE}/credit-notes`, { lines: [{ description: 'ab', amount: '1' }], reason: 'x'.repeat(5) })).status).toBe(400);
    expect(invoices.creditNote).toHaveBeenCalledTimes(1);
  });
});

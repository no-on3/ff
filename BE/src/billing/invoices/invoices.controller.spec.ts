/**
 * L1: the account's invoice routes (client-readiness plan, P-36) through
 * HTTP, with the validation main.ts sets up: who may call them, the account
 * they act for, and the PDFs they send. The service runs against PostgreSQL in
 * invoices.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../../accounts/entities/account.entity';
import { Principal } from '../../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../../auth/route-rules';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

const ACCOUNT = '000000000001';
const INVOICE = '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60';
const PDF = Buffer.from('%PDF-1.3\n% an invoice\n');

describe('the invoice routes (L1, P-36)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const invoices = {
    forAccount: jest.fn(async () => [{ id: INVOICE, number: 'FAC-2026-000001' }]),
    pdf: jest.fn(async () => ({ body: PDF, number: 'FAC-2026-000001' })),
    statementPdf: jest.fn(async () => PDF),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [InvoicesController], providers: [{ provide: InvoicesService, useValue: invoices }] }).compile();
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

  it('let every member read them, and an API key with usage:read, whatever the account status', () => {
    const reflector = new Reflector();
    const rules = (handler: object) => [reflector.get(ROLES, handler as never), reflector.get(ACTIVE_ACCOUNT, handler as never), reflector.get(SCOPE, handler as never)];

    for (const handler of [InvoicesController.prototype.list, InvoicesController.prototype.pdf, InvoicesController.prototype.statement]) {
      expect(rules(handler)).toEqual([undefined, undefined, 'usage:read']);
    }
  });

  it("list the caller's account's", async () => {
    expect(await (await fetch(`${baseUrl}/billing/invoices`)).json()).toEqual({ invoices: [{ id: INVOICE, number: 'FAC-2026-000001' }] });
    expect(invoices.forAccount).toHaveBeenCalledWith(ACCOUNT);
  });

  it("send an invoice's PDF, the caller's account's only, named by its number", async () => {
    const res = await fetch(`${baseUrl}/billing/invoices/${INVOICE}/pdf`);

    expect([res.status, res.headers.get('content-type'), res.headers.get('content-disposition')]).toEqual([200, 'application/pdf', 'attachment; filename="FAC-2026-000001.pdf"']);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    expect(invoices.pdf).toHaveBeenCalledWith(INVOICE, ACCOUNT);
    expect((await fetch(`${baseUrl}/billing/invoices/FAC-2026-000001/pdf`)).status).toBe(400);
  });

  it("send a month's usage statement, named by the month", async () => {
    const res = await fetch(`${baseUrl}/billing/statements/2026-10/pdf`);

    expect([res.status, res.headers.get('content-disposition')]).toEqual([200, 'attachment; filename="releve-2026-10.pdf"']);
    expect(invoices.statementPdf).toHaveBeenCalledWith(ACCOUNT, '2026-10');
  });
});

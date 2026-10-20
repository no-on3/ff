/**
 * L1: the admin payment routes (client-readiness plan, P-35; cancelling, P-74) through HTTP,
 * with the validation main.ts sets up and the certificate's body parser the
 * admin module applies: what each passes on, and what each refuses. The
 * service runs against PostgreSQL in payments.db.spec.ts; who may call them
 * is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PaymentsService } from '../billing/payments/payments.service';
import { AdminPaymentsController, certificateBody } from './admin-payments.controller';
import { IS_ADMIN, Operator, reasonOf } from './operator';

const OPERATOR: Operator = { id: 'kc-op-1', email: 'operator@ff.test' };
const PAYMENT = '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60';
const PDF = Buffer.from('%PDF-1.4\n% a withholding certificate\n');

describe('the admin payment routes (L1, P-35)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const payments = {
    forOperators: jest.fn(async () => ({ payments: [], next: null })),
    recordTransfer: jest.fn(async () => ({ id: PAYMENT })),
    attachCertificate: jest.fn(async (..._args: unknown[]) => ({ id: PAYMENT })),
    certificate: jest.fn(async () => ({ body: PDF, contentType: 'application/pdf', reference: 'FF-7KQ2-9MXA' })),
    cancelPayment: jest.fn(async () => ({ id: PAYMENT, status: 'cancelled' })),
  };
  const json = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, (await res.json()).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminPaymentsController],
      providers: [{ provide: PaymentsService, useValue: payments }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use('/admin/payments/:id/withholding-certificate', certificateBody()); // as the admin module applies it
    // The operator, where the guard puts it (P-70).
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
    expect(new Reflector().get(IS_ADMIN, AdminPaymentsController)).toBe(true);
  });

  it('list the payments, filtered and a page at a time, and refuse a filter that is not one', async () => {
    expect((await json('GET', '/admin/payments?status=pending&accountId=000000000001&limit=10')).status).toBe(200);
    expect(payments.forOperators).toHaveBeenCalledWith({ status: 'pending', accountId: '000000000001', reference: undefined }, { limit: 10, before: undefined });
    expect((await json('GET', '/admin/payments?reference=ff7kq29mxa')).status).toBe(200);
    expect(payments.forOperators).toHaveBeenLastCalledWith({ status: undefined, accountId: undefined, reference: 'ff7kq29mxa' }, { limit: 50, before: undefined });

    expect(await refusal(await json('GET', '/admin/payments?status=lost'))).toEqual([400, ['status must be one of: pending, paid, cancelled']]);
    expect((await json('GET', '/admin/payments?status=cancelled')).status).toBe(200);
    expect(await refusal(await json('GET', '/admin/payments?accountId=1'))).toEqual([400, ['accountId must be an account ID: 12 digits']]);
    expect(await refusal(await json('GET', '/admin/payments?limit=0'))).toEqual([400, ['limit must not be less than 1']]);
  });

  it('cancel a pending pro-forma with its reason, 200 with it; a reason and an ID needed (P-74)', async () => {
    const res = await json('POST', `/admin/payments/${PAYMENT}/cancel`, { reason: 'Asked for twice by mistake' });

    expect([res.status, await res.json()]).toEqual([200, { id: PAYMENT, status: 'cancelled' }]);
    expect(payments.cancelPayment).toHaveBeenCalledWith(PAYMENT, 'Asked for twice by mistake');
    expect(await refusal(await json('POST', `/admin/payments/${PAYMENT}/cancel`, {}))).toEqual([
      400,
      ['reason must be longer than or equal to 3 characters', 'reason must be a string'],
    ]);
    expect((await json('POST', '/admin/payments/FF-7KQ2-9MXA/cancel', { reason: 'Asked for twice' })).status).toBe(400);
    expect(payments.cancelPayment).toHaveBeenCalledTimes(1);
  });

  it('record a transfer as the bank statement shows it, with its reason', async () => {
    const transfer = { reference: 'ff-7kq2-9mxa', received: '58.608', withheld: '0.892', receivedOn: '2026-10-20', bankReference: 'VIR-0042', reason: 'Statement of 20 October' };

    const res = await json('POST', '/admin/bank-transfers', transfer);

    expect(res.status).toBe(201);
    expect(payments.recordTransfer).toHaveBeenCalledWith(expect.objectContaining({ reference: 'ff-7kq2-9mxa', received: '58.608', withheld: '0.892', receivedOn: '2026-10-20', bankReference: 'VIR-0042' }), 'Statement of 20 October');
  });

  it('refuse a transfer whose amounts or date are not ones', async () => {
    const transfer = { reference: 'FF-7KQ2-9MXA', received: '59.500', withheld: '0', receivedOn: '2026-10-20', reason: 'Statement of 20 October' };

    expect(await refusal(await json('POST', '/admin/bank-transfers', { ...transfer, received: '59,500' }))).toEqual([400, ['received must be an amount, such as 59.500']]);
    expect(await refusal(await json('POST', '/admin/bank-transfers', { ...transfer, withheld: '-1' }))).toEqual([400, ['withheld must be an amount, such as 0.892, or 0']]);
    expect(await refusal(await json('POST', '/admin/bank-transfers', { ...transfer, receivedOn: '20/10/2026' }))).toEqual([400, ['receivedOn must be a date, such as 2026-10-20']]);
    expect(payments.recordTransfer).not.toHaveBeenCalled();
  });

  it('take a certificate as the body, a PDF or an image, its reason in X-FF-Reason, URI-encoded', async () => {
    const reason = 'Certificat reçu par e-mail le 21/10';
    const res = await fetch(`${baseUrl}/admin/payments/${PAYMENT}/withholding-certificate`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf; name=certificat.pdf', 'x-ff-reason': encodeURIComponent(reason) },
      body: PDF,
    });

    expect(res.status).toBe(200);
    const [id, body, type, given] = payments.attachCertificate.mock.calls[0];
    expect([id, Buffer.isBuffer(body) && body.equals(PDF), type, given]).toEqual([PAYMENT, true, 'application/pdf', reason]);
  });

  it('refuse a certificate over 5 MB', async () => {
    const res = await fetch(`${baseUrl}/admin/payments/${PAYMENT}/withholding-certificate`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-ff-reason': 'Scan' },
      body: Buffer.alloc(5 * 1024 * 1024 + 1),
    });

    expect(res.status).toBe(413);
    expect(payments.attachCertificate).not.toHaveBeenCalled();
  });

  it('give the certificate back, as a download named after the reference', async () => {
    const res = await fetch(`${baseUrl}/admin/payments/${PAYMENT}/withholding-certificate`);

    expect([res.status, res.headers.get('content-type'), res.headers.get('content-disposition')]).toEqual([
      200,
      'application/pdf',
      'attachment; filename="withholding-FF-7KQ2-9MXA.pdf"',
    ]);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("read a change's reason from the JSON body, else from the header, URI-encoded", () => {
    expect(reasonOf({ body: { reason: 'From the body' }, headers: { 'x-ff-reason': 'From%20the%20header' } })).toBe('From the body');
    expect(reasonOf({ body: PDF, headers: { 'x-ff-reason': 'From%20the%20header' } })).toBe('From the header');
    expect(reasonOf({ body: {}, headers: { 'x-ff-reason': '%E0%A4%A' } })).toBeNull(); // not URI-encoded
    expect(reasonOf({ body: {}, headers: { 'x-ff-reason': 'ok' } })).toBeNull(); // too short
    expect(reasonOf({ body: {}, headers: {} })).toBeNull();
  });
});

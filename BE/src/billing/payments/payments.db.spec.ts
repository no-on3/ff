/**
 * L2: bank transfers (client-readiness plan, P-35, D9; parent §8.5) against a
 * real PostgreSQL server, in a scratch database that is dropped after: a
 * pro-forma, the buyer as the account was; a transfer recorded against its
 * reference, whole or net of the share withheld at source, and its ledger
 * entries; the certificate that credits that share; what is refused, with
 * nothing written; two operators at once; the owners' e-mails; the
 * operators' list. A pending pro-forma cancelled by its owner or an operator,
 * and a transfer that comes for it anyway (P-74).
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../../accounts/entities/account.entity';
import { Membership } from '../../accounts/entities/membership.entity';
import { User } from '../../accounts/entities/user.entity';
import { AuditEntry } from '../../audit/audit-entry.entity';
import { AuditService } from '../../audit/audit.service';
import { withRequestContext } from '../../common/request-context';
import { databaseConfiguration } from '../../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../../database/scratch-database';
import { Mail } from '../../mail/mail.service';
import { capturingMail } from '../../mail/capturing-mail';
import { MinioClientService } from '../../minio-client/minio-client.service';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentStatus } from './payment.entity';
import { PaymentsService } from './payments.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const SELLER = { name: 'FF SARL', taxId: '1234567/A/M/000', address: '1 rue du Lac, 1053 Tunis' };
const BANK = { name: 'Banque de Tunisie', iban: 'TN59 1000 6035 1835 9847 8831', bic: null };
const OWNER = { id: 'user:3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f', label: 'owner@ff.test' };
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };
const PDF = Buffer.from('%PDF-1.4\n% certificat de retenue à la source\n');

run('bank transfers (L2, P-35)', () => {
  let db: ScratchDatabase;
  let payments: PaymentsService;
  let ledger: LedgerService;
  const sent: Mail[] = [];
  const documents = new Map<string, { body: Buffer; contentType: string }>();
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const as = <T>(actor: typeof OWNER, work: () => Promise<T>) => withRequestContext({ requestId: `test-${++n}`, actor }, work);

  /** An active account, with its owners, and developers who must never get the owners' e-mails. */
  async function account(name = `Account ${++n}`, owners: string[] = [], developers: string[] = []): Promise<string> {
    const id = String(800000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name, planId: 'beta', status: AccountStatus.ACTIVE, taxId: '7654321/B/A/M/000' });
    for (const [email, role] of [...owners.map((e) => [e, 'owner'] as const), ...developers.map((e) => [e, 'developer'] as const)]) {
      // In English, as the e-mails these tests read; each in its own language is checked in language.spec.ts.
      const user = await db.dataSource.getRepository(User).save({ oidcSub: `kc-${email}`, email, name: null, locale: 'en' });
      await db.dataSource.getRepository(Membership).save({ accountId: id, userId: user.id, role });
    }
    return id;
  }
  /** The entries of a ledger transaction, by key: [account type, amount]. */
  const entries = (key: string) =>
    query<Array<{ type: string; amount: string }>>(
      `SELECT a.type, e.amount_minor::text AS amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.idempotency_key = $1 ORDER BY e.id`,
      [key],
    ).then((rows) => rows.map((row) => [row.type, Number(row.amount)]));
  const audit = (accountId: string) => db.dataSource.getRepository(AuditEntry).find({ where: { accountId }, order: { id: 'ASC' } });
  const transfer = (reference: string, received: string, withheld = '0', receivedOn = '2026-10-16') => ({ reference, received, withheld, receivedOn, bankReference: 'VIR-0042' });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    ledger = new LedgerService(ds);
    const mail = capturingMail(sent);
    const storage = {
      putDocument: async (key: string, body: Buffer, contentType: string) => void documents.set(key, { body, contentType }),
      getDocument: async (key: string) => documents.get(key) as { body: Buffer; contentType: string },
    } as unknown as MinioClientService;
    const config = { getOrThrow: (key: string) => (key === 'mail' ? { consoleUrl: 'https://console.ff.example' } : { seller: SELLER, bank: BANK }) } as unknown as ConfigService;
    payments = new PaymentsService(ds, ledger, new AuditService(ds.getRepository(AuditEntry)), mail, storage, config);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  describe('a pro-forma', () => {
    it("gives the credit, D9's 19% VAT on top, the buyer as the account is, FF and its bank, and a reference; in the audit log", async () => {
      const a = await account('Tunis Labs');

      const proForma = await as(OWNER, () => payments.requestProForma(a, '50'));

      expect(proForma).toMatchObject({
        status: 'pending',
        currency: 'TND',
        credit: '50.000',
        vatPercent: 19,
        vat: '9.500',
        total: '59.500',
        buyer: { name: 'Tunis Labs', taxId: '7654321/B/A/M/000' },
        seller: SELLER,
        bank: BANK,
        transfer: null,
      });
      expect(proForma.reference).toMatch(/^FF-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
      expect(await query(`SELECT requested_by FROM payments WHERE id = $1`, [proForma.id])).toEqual([{ requested_by: OWNER.id }]);
      expect((await audit(a)).map((entry) => [entry.actor, entry.action, entry.resource, entry.details])).toEqual([
        [OWNER.id, 'billing.pro_forma', `payment:${proForma.id}`, { reference: proForma.reference, credit: '50.000', total: '59.500', currency: 'TND' }],
      ]);
    });

    it('keeps the buyer as the account was when it was asked for', async () => {
      const a = await account('Old name');
      const proForma = await payments.requestProForma(a, '20.000');
      await db.dataSource.getRepository(Account).update({ id: a }, { name: 'New name', taxId: null });

      expect((await payments.proForma(a, proForma.id)).buyer).toEqual({ name: 'Old name', taxId: '7654321/B/A/M/000' });
    });

    it("refuses a credit out of bounds, or finer than the currency's minor unit", async () => {
      const a = await account();

      await expect(payments.requestProForma(a, '9.999')).rejects.toThrow('credit must be from 10.000 to 1000000.000 TND');
      await expect(payments.requestProForma(a, '1000000.001')).rejects.toThrow('credit must be from 10.000 to 1000000.000 TND');
      await expect(payments.requestProForma(a, '10.0001')).rejects.toThrow('credit: "10.0001" is not an amount with 3 decimals at most, such as 50.000');
      expect(await query(`SELECT count(*)::int AS n FROM payments WHERE account_id = $1`, [a])).toEqual([{ n: 0 }]);
    });

    it("lists and reads only the account's own", async () => {
      const [a, b] = [await account(), await account()];
      const first = await payments.requestProForma(a, '10');
      const second = await payments.requestProForma(a, '20');

      expect((await payments.proFormas(a)).map((proForma) => proForma.id)).toEqual([second.id, first.id]);
      expect(await payments.proFormas(b)).toEqual([]);
      await expect(payments.proForma(b, first.id)).rejects.toThrow(`Pro-forma ${first.id} not found`);
    });
  });

  describe('a transfer', () => {
    it("of the whole total: the credit to the wallet, the VAT owed, the total at the bank; the owners told; once", async () => {
      const a = await account('Whole', ['whole-owner@ff.test'], ['whole-developer@ff.test']);
      const proForma = await payments.requestProForma(a, '50.000');

      const recorded = await as(OPERATOR, () => payments.recordTransfer(transfer(proForma.reference.toLowerCase().replace(/-/g, ' '), '59.500'), 'Statement of 16 October'));

      expect(recorded).toMatchObject({
        status: 'paid',
        recordedBy: OPERATOR.id,
        bankReference: 'VIR-0042',
        transfer: { received: '59.500', withheld: '0.000', receivedOn: '2026-10-16', credited: '50.000', withheldCreditedAt: null },
      });
      expect(await entries(`transfer:${proForma.id}`)).toEqual([
        ['wallet', 50000],
        ['vat_payable', 9500],
        ['provider_clearing', -59500],
      ]);
      expect(await ledger.balance(a, 'TND')).toBe(50000n);
      expect((await audit(a)).at(-1)).toMatchObject({
        actor: OPERATOR.id,
        action: 'payment.record',
        details: { reason: 'Statement of 16 October', reference: proForma.reference, currency: 'TND', received: '59.500', withheld: '0.000', receivedOn: '2026-10-16', bankReference: 'VIR-0042' },
      });
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['whole-owner@ff.test', 'Your transfer was received: Whole']]);
      expect(sent[0].text).not.toContain('withheld');

      await expect(payments.recordTransfer(transfer(proForma.reference, '59.500'), 'Again')).rejects.toThrow(
        `The transfer for ${proForma.reference} was recorded on ${new Date().toISOString().slice(0, 10)}: 59.500 TND received`,
      );
      expect(await ledger.balance(a, 'TND')).toBe(50000n);
    });

    it('net of a share withheld at source: the credit less that share now, the share with the certificate, against the tax FF claims', async () => {
      const a = await account('Net', ['net-owner@ff.test'], ['net-developer@ff.test']);
      await db.dataSource.query(`UPDATE "users" SET "locale" = 'fr-TN' WHERE "email" = $1`, ['net-owner@ff.test']); // and this owner's e-mails in French
      const proForma = await payments.requestProForma(a, '50.000');

      await payments.recordTransfer(transfer(proForma.reference, '58.608', '0.892'), 'Statement, 1.5% withheld');

      expect(await entries(`transfer:${proForma.id}`)).toEqual([
        ['wallet', 49108],
        ['vat_payable', 9500], // owed in full: the share withheld is income tax, not VAT
        ['provider_clearing', -58608],
      ]);
      expect(await ledger.balance(a, 'TND')).toBe(49108n);
      expect(sent[0].text).toContain('0,892\u00a0TND ont été retenus à la source : ils seront ajoutés à votre crédit dès que nous recevrons le certificat de retenue.');

      const added = await as(OPERATOR, () => payments.attachCertificate(proForma.id, PDF, 'application/pdf', 'Certificate from the tax platform'));

      expect(added).toMatchObject({ certificateType: 'application/pdf', transfer: { withheldCreditedAt: expect.any(Date) } });
      expect(await entries(`withholding:${proForma.id}`)).toEqual([
        ['wallet', 892],
        ['withholding_receivable', -892],
      ]);
      expect(await ledger.balance(a, 'TND')).toBe(50000n);
      expect((await audit(a)).at(-1)).toMatchObject({
        actor: OPERATOR.id,
        action: 'payment.withholding',
        details: { reason: 'Certificate from the tax platform', reference: proForma.reference, currency: 'TND', withheld: '0.892', certificate: { type: 'application/pdf', bytes: PDF.length } },
      });
      expect(sent.map((mail) => mail.subject)).toEqual(['Votre virement est arrivé : Net', 'La retenue à la source a été ajoutée : Net']);
      const kept = await payments.certificate(proForma.id);
      expect([kept.body.equals(PDF), kept.contentType, kept.reference]).toEqual([true, 'application/pdf', proForma.reference]);

      await expect(payments.attachCertificate(proForma.id, PDF, 'application/pdf', 'Again')).rejects.toThrow(`The certificate for ${proForma.reference} was added on`);
      expect(await ledger.balance(a, 'TND')).toBe(50000n);
    });

    it('refuses a certificate where there is none to add, or that is no PDF or image', async () => {
      const a = await account();
      const [pending, whole, net] = [await payments.requestProForma(a, '10'), await payments.requestProForma(a, '10'), await payments.requestProForma(a, '10')];
      await payments.recordTransfer(transfer(whole.reference, '11.900'), 'Whole');
      await payments.recordTransfer(transfer(net.reference, '11.722', '0.178'), 'Net');

      await expect(payments.attachCertificate(pending.id, PDF, 'application/pdf', 'Too soon')).rejects.toThrow(`The transfer for ${pending.reference} isn't recorded yet`);
      await expect(payments.attachCertificate(whole.id, PDF, 'application/pdf', 'Nothing withheld')).rejects.toThrow(
        `Nothing was withheld at source on ${whole.reference}: there is no certificate to add`,
      );
      await expect(payments.attachCertificate(net.id, PDF, 'text/plain', 'A text')).rejects.toThrow('A certificate is a PDF, a PNG or a JPEG, not text/plain');
      await expect(payments.attachCertificate(net.id, Buffer.alloc(0), 'application/pdf', 'Empty')).rejects.toThrow('The certificate is empty');
      await expect(payments.certificate(net.id)).rejects.toThrow(`No certificate was added for ${net.reference}`);
      expect(await entries(`withholding:${net.id}`)).toEqual([]);
    });

    it("refuses one that doesn't make the total, an unknown reference, one that isn't a reference, or a day to come, writing nothing", async () => {
      const a = await account();
      const proForma = await payments.requestProForma(a, '50.000');

      await expect(payments.recordTransfer(transfer(proForma.reference, '59.400'), 'Short')).rejects.toThrow(
        "received 59.400 TND and withheld 0.000 TND make 59.400 TND, not the pro-forma's 59.500 TND",
      );
      await expect(payments.recordTransfer(transfer(proForma.reference, '59.5000'), 'Too fine')).rejects.toThrow('received: "59.5000" is not an amount with 3 decimals at most');
      await expect(payments.recordTransfer(transfer('FF-2222-2222', '59.500'), 'Unknown')).rejects.toThrow('No pro-forma has the reference FF-2222-2222');
      await expect(payments.recordTransfer(transfer('INV-42', '59.500'), 'Not one')).rejects.toThrow('"INV-42" is not a payment reference, such as FF-7KQ2-9MXA');
      await expect(payments.recordTransfer(transfer(proForma.reference, '59.500', '0', '2099-01-01'), 'Future')).rejects.toThrow('receivedOn must be a day that has come, not 2099-01-01');

      expect([(await payments.proForma(a, proForma.id)).status, await entries(`transfer:${proForma.id}`), await ledger.balance(a, 'TND')]).toEqual(['pending', [], 0n]);
    });

    it('is recorded once when two operators record it at the same moment', async () => {
      const a = await account();
      const proForma = await payments.requestProForma(a, '100');

      const results = await Promise.allSettled([
        payments.recordTransfer(transfer(proForma.reference, '119.000'), 'First'),
        payments.recordTransfer(transfer(proForma.reference, '119.000'), 'Second'),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(String((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain(`The transfer for ${proForma.reference} was recorded on`);
      expect(await ledger.balance(a, 'TND')).toBe(100000n);
    });
  });

  describe('cancelling a pending pro-forma (P-74)', () => {
    it("by its owner: cancelled, when and by whom, in the audit log; again, nothing more; no e-mail, the owner did it", async () => {
      const a = await account('Cancel Labs', ['cancel-owner@ff.test']);
      const proForma = await as(OWNER, () => payments.requestProForma(a, '50'));
      const at = new Date('2026-10-17T09:00:00Z');

      const cancelled = await as(OWNER, () => payments.cancelProForma(a, proForma.id, at));

      expect([cancelled.status, cancelled.cancelledAt, cancelled.transfer]).toEqual(['cancelled', at, null]);
      expect(await query('SELECT status, cancelled_at, cancelled_by FROM payments WHERE id = $1', [proForma.id])).toEqual([{ status: 'cancelled', cancelled_at: at, cancelled_by: OWNER.id }]);
      const logged = () => audit(a).then((entries) => entries.map((entry) => [entry.actor, entry.action, entry.details]));
      expect(await logged()).toEqual([
        [OWNER.id, 'billing.pro_forma', expect.anything()],
        [OWNER.id, 'billing.pro_forma_cancel', { reference: proForma.reference, total: '59.500', currency: 'TND' }],
      ]);

      const again = await as(OWNER, () => payments.cancelProForma(a, proForma.id, new Date('2026-10-18T09:00:00Z')));
      expect([again.status, again.cancelledAt, (await logged()).length, sent.length]).toEqual(['cancelled', at, 2, 0]);
      expect((await payments.proFormas(a)).map((one) => one.status)).toEqual(['cancelled']);
    });

    it("refuses another account's, writing nothing, and a paid one", async () => {
      const [a, b] = [await account(), await account()];
      const proForma = await payments.requestProForma(a, '10');

      await expect(payments.cancelProForma(b, proForma.id)).rejects.toThrow(new NotFoundException(`Pro-forma ${proForma.id} not found`));
      expect((await payments.proForma(a, proForma.id)).status).toBe('pending');

      await payments.recordTransfer(transfer(proForma.reference, '11.900', '0', '2026-10-15'), 'Paid');
      await expect(payments.cancelProForma(a, proForma.id)).rejects.toThrow(
        new ConflictException(`The transfer for ${proForma.reference} was recorded on ${new Date().toISOString().slice(0, 10)}: a paid pro-forma isn't cancelled`),
      );
      await expect(payments.cancelPayment(proForma.id, 'Asked twice')).rejects.toThrow("a paid pro-forma isn't cancelled");
      await expect(payments.cancelPayment('6f1c2d3e-4b5a-4c6d-8e7f-001122334455', 'Asked twice')).rejects.toThrow(
        new NotFoundException('Payment 6f1c2d3e-4b5a-4c6d-8e7f-001122334455 not found'),
      );
    });

    it('by an operator, with a reason: in the audit log, and the owners told why, not the other members', async () => {
      const a = await account('Ops Labs', ['ops-owner@ff.test'], ['ops-dev@ff.test']);
      const proForma = await payments.requestProForma(a, '20');

      const cancelled = await as(OPERATOR, () => payments.cancelPayment(proForma.id, 'Asked for twice by mistake'));

      expect([cancelled.status, cancelled.cancelledBy, cancelled.accountId]).toEqual(['cancelled', OPERATOR.id, a]);
      expect((await audit(a)).at(-1)).toMatchObject({
        actor: OPERATOR.id,
        action: 'payment.cancel',
        resource: `payment:${proForma.id}`,
        details: { reason: 'Asked for twice by mistake', reference: proForma.reference, total: '23.800', currency: 'TND' },
      });
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['ops-owner@ff.test', `Your pro-forma ${proForma.reference} was cancelled: Ops Labs`]]);
      expect(sent[0].text).toContain('Why: Asked for twice by mistake');

      sent.length = 0;
      await as(OPERATOR, () => payments.cancelPayment(proForma.id, 'Again'));
      expect([sent.length, (await audit(a)).length]).toEqual([0, 2]);
    });

    it('lets a transfer that comes anyway pay it: credited, the cancellation kept, the audit entry saying so', async () => {
      const a = await account('Late Labs', ['late-owner@ff.test']);
      const proForma = await payments.requestProForma(a, '50');
      const at = new Date('2026-10-17T09:00:00Z');
      await as(OWNER, () => payments.cancelProForma(a, proForma.id, at));

      const paid = await as(OPERATOR, () => payments.recordTransfer(transfer(proForma.reference, '59.500'), 'It came anyway'));

      expect([paid.status, paid.cancelledAt, paid.cancelledBy, paid.transfer?.credited]).toEqual(['paid', at, OWNER.id, '50.000']);
      expect(await ledger.balance(a, 'TND')).toBe(50000n);
      expect((await audit(a)).at(-1)).toMatchObject({ action: 'payment.record', details: { reason: 'It came anyway', wasCancelled: true } });
      expect(sent.map((mail) => mail.subject)).toEqual(['Your transfer was received: Late Labs']);
    });

    it('lists the cancelled ones for operators, and the database keeps the dates and statuses together', async () => {
      const a = await account();
      const [kept, dropped] = [await payments.requestProForma(a, '10'), await payments.requestProForma(a, '30')];
      await as(OWNER, () => payments.cancelProForma(a, dropped.id));

      const cancelled = await payments.forOperators({ status: PaymentStatus.CANCELLED, accountId: a }, { limit: 50 });
      const pending = await payments.forOperators({ status: PaymentStatus.PENDING, accountId: a }, { limit: 50 });
      expect([cancelled.payments.map((payment) => payment.id), pending.payments.map((payment) => payment.id)]).toEqual([[dropped.id], [kept.id]]);

      // A pending one with a date, a cancelled one without, a date without who: each refused.
      for (const change of [
        `status = 'pending', cancelled_at = now(), cancelled_by = 'user:x'`,
        `status = 'cancelled', cancelled_at = NULL, cancelled_by = NULL`,
        `cancelled_at = now(), cancelled_by = NULL`,
      ]) {
        const id = change.startsWith(`status = 'pending'`) ? dropped.id : change.startsWith(`status = 'cancelled'`) ? kept.id : dropped.id;
        await expect(query(`UPDATE payments SET ${change} WHERE id = $1`, [id])).rejects.toThrow('violates check constraint "CHK_67b14a70c30673f7e1ef7250fb"');
      }
    });
  });

  it('lists every account\'s payments for operators, newest first, by status, account and reference, a page at a time', async () => {
    const [a, b] = [await account(), await account()];
    const [first, second] = [await payments.requestProForma(a, '10'), await payments.requestProForma(b, '10')];
    await payments.recordTransfer(transfer(first.reference, '11.900'), 'Paid');

    const page = await payments.forOperators({ accountId: a }, { limit: 50 });
    expect(page.payments.map((payment) => [payment.id, payment.status, payment.accountId])).toEqual([[first.id, 'paid', a]]);
    const pending = await payments.forOperators({ status: PaymentStatus.PENDING }, { limit: 500 });
    expect(pending.payments.some((payment) => payment.id === second.id) && pending.payments.every((payment) => payment.status === PaymentStatus.PENDING)).toBe(true);

    const one = await payments.forOperators({}, { limit: 1 });
    const next = await payments.forOperators({}, { limit: 1, before: one.next as string });
    expect([one.payments[0].id, next.payments[0].id]).toEqual([second.id, first.id]);

    // A reference as typed from a bank statement finds its pro-forma, and only it.
    const typed = ` ${second.reference.toLowerCase().replace(/-/g, '')} `;
    expect((await payments.forOperators({ reference: typed }, { limit: 50 })).payments.map((payment) => payment.id)).toEqual([second.id]);
    expect((await payments.forOperators({ reference: 'FF-2222-2222' }, { limit: 50 })).payments).toEqual([]);
    await expect(payments.forOperators({ reference: 'VIR-0042' }, { limit: 50 })).rejects.toThrow('"VIR-0042" is not a payment reference, such as FF-7KQ2-9MXA');
  });
});

/**
 * L2: monthly invoices (client-readiness plan, P-36, D9; parent §8.6) against
 * a real PostgreSQL server, in a scratch database that is dropped after: a
 * month with two transfers, one net of withholding tax, invoiced and its
 * stamp duty taken; a month without payments, and its usage statement;
 * numbering under concurrency, gapless when one fails; credit notes and their
 * limits; documents never changed; a transfer recorded late; tax rates by
 * date; the operator's e-mails, once across backends; the operators' list.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../../accounts/entities/account.entity';
import { Membership } from '../../accounts/entities/membership.entity';
import { User } from '../../accounts/entities/user.entity';
import { PlatformSettingsService } from '../../admin/platform-settings.service';
import { AuditEntry } from '../../audit/audit-entry.entity';
import { AuditService } from '../../audit/audit.service';
import { withRequestContext } from '../../common/request-context';
import { databaseConfiguration } from '../../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../../database/scratch-database';
import { Mail, MailService } from '../../mail/mail.service';
import { MinioClientService } from '../../minio-client/minio-client.service';
import { Currency } from '../currency.entity';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentsService } from '../payments/payments.service';
import { PriceBook } from '../price-book.entity';
import { PricingService } from '../pricing.service';
import { stampDutyOn } from '../tax-rates';
import { InvoiceNoticesService } from './invoice-notices.service';
import { InvoiceKind } from './invoice.entity';
import { InvoicesService } from './invoices.service';
import { pdfRows } from './pdf-text';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const SELLER = { name: 'FF SARL', taxId: '1234567/A/M/000', address: '1 rue du Lac, 1053 Tunis' };
const BANK = { name: 'Banque de Tunisie', iban: 'TN59 1000 6035 1835 9847 8831', bic: null };
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };
const NOV_2 = new Date('2026-11-02T09:00:00Z');
const NBSP = String.fromCharCode(0xa0);

run('monthly invoices (L2, P-36)', () => {
  let db: ScratchDatabase;
  let ledger: LedgerService;
  let payments: PaymentsService;
  let invoices: InvoicesService;
  let notices: () => InvoiceNoticesService;
  const sent: Mail[] = [];
  const documents = new Map<string, { body: Buffer; contentType: string }>();
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  const as = <T>(actor: typeof OPERATOR, work: () => Promise<T>) => withRequestContext({ requestId: `test-${++n}`, actor }, work);
  /** A PDF kept in storage, as rows of text, page by page, its no-break spaces plain. */
  const kept = (key: string) => pdfRows(documents.get(key)?.body ?? Buffer.alloc(0)).map((rows) => rows.map((row) => row.replaceAll(NBSP, ' ')));

  /** An active account, with its owners, and developers who must never get the owners' e-mails. */
  async function account(name = `Account ${++n}`, owners: string[] = [], developers: string[] = []): Promise<string> {
    const id = String(700000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name, planId: 'beta', status: AccountStatus.ACTIVE, taxId: '7654321/B/A/M/000' });
    for (const [email, role] of [...owners.map((e) => [e, 'owner'] as const), ...developers.map((e) => [e, 'developer'] as const)]) {
      const user = await db.dataSource.getRepository(User).save({ oidcSub: `kc-${email}`, email, name: null });
      await db.dataSource.getRepository(Membership).save({ accountId: id, userId: user.id, role });
    }
    return id;
  }
  /** A pro-forma for this credit, then its transfer, received on that day, as P-35 records them. */
  async function paid(accountId: string, credit: string, receivedOn: string, received: string, withheld = '0', recordedAt = `${receivedOn}T18:00:00Z`) {
    const proForma = await payments.requestProForma(accountId, credit, new Date(`${receivedOn}T08:00:00Z`));
    await payments.recordTransfer({ reference: proForma.reference, received, withheld, receivedOn }, 'Bank statement', new Date(recordedAt));
    return proForma;
  }
  /** The entries of a ledger transaction, by key: [account type, amount]. */
  const entries = (key: string) =>
    query<Array<{ type: string; amount: string }>>(
      `SELECT a.type, e.amount_minor::text AS amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.idempotency_key = $1 ORDER BY e.id`,
      [key],
    ).then((rows) => rows.map((row) => [row.type, Number(row.amount)]));
  const audit = (accountId: string) => db.dataSource.getRepository(AuditEntry).find({ where: { accountId }, order: { id: 'ASC' } });
  const lastNumber = async (series: string) =>
    (await query<Array<{ last: number }>>(`SELECT last_number AS last FROM invoice_counters WHERE series = $1 AND fiscal_year = 2026`, [series]))[0]?.last ?? 0;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    ledger = new LedgerService(ds);
    const mail = { send: async (message: Mail) => sent.push(message) > 0 } as unknown as MailService;
    const storage = {
      putDocument: async (key: string, body: Buffer, contentType: string) => void documents.set(key, { body, contentType }),
      getDocument: async (key: string) => documents.get(key) as { body: Buffer; contentType: string },
    } as unknown as MinioClientService;
    const config = {
      getOrThrow: (key: string) =>
        key === 'mail' ? { consoleUrl: 'https://console.ff.example', operatorEmail: 'operator@ff.test', adminUrl: 'https://admin.ff.example' } : { seller: SELLER, bank: BANK },
    } as unknown as ConfigService;
    const auditService = new AuditService(ds.getRepository(AuditEntry));
    payments = new PaymentsService(ds, ledger, auditService, mail, storage, config);
    invoices = new InvoicesService(ds, ledger, new PricingService(ds.getRepository(PriceBook), ds.getRepository(Currency)), auditService, mail, storage, config);
    const settings = { get: async () => ({ invoiceReminderDay: 3 }) } as unknown as PlatformSettingsService;
    notices = () => new InvoiceNoticesService(ds, invoices, settings, mail, config);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('invoices a month with two transfers, one net of withholding tax: a line each, the stamp duty taken, numbered, its PDF kept, the owners told', async () => {
    const [a, b] = [await account('Tunis Labs', ['owner@tunis-labs.test'], ['dev@tunis-labs.test']), await account('Other')];
    const first = await paid(a, '50', '2026-10-05', '59.500');
    const second = await paid(a, '1000', '2026-10-20', '1172.265', '17.735');
    const before = await ledger.balance(a, 'TND'); // 50.000 + 1000.000 less the 17.735 withheld
    sent.length = 0;

    expect(await invoices.drafts('2026-10', NOV_2)).toEqual({
      month: '2026-10',
      issuable: true,
      drafts: [
        {
          accountId: a,
          buyerName: 'Tunis Labs',
          buyerTaxId: '7654321/B/A/M/000',
          currency: 'TND',
          lines: [
            { paymentId: first.id, reference: first.reference, receivedOn: '2026-10-05', description: `Crédit prépayé FF : virement reçu le 5 octobre 2026, pro forma ${first.reference}`, amount: '50.000', vatPercent: 19, vat: '9.500' },
            { paymentId: second.id, reference: second.reference, receivedOn: '2026-10-20', description: `Crédit prépayé FF : virement reçu le 20 octobre 2026, pro forma ${second.reference}`, amount: '1000.000', vatPercent: 19, vat: '190.000' },
          ],
          subtotal: '1050.000',
          vat: '199.500',
          stampDuty: '1.000',
          total: '1250.500',
          withheld: '17.735',
        },
      ],
    });

    const issued = await as(OPERATOR, () => invoices.issue(a, '2026-10', 'October reviewed', NOV_2));

    expect(issued).toMatchObject({
      kind: 'invoice',
      number: 'FAC-2026-000001',
      month: '2026-10',
      issuedOn: '2026-11-02',
      subtotal: '1050.000',
      vat: '199.500',
      stampDuty: '1.000',
      total: '1250.500',
      withheld: '17.735',
      corrects: null,
      accountId: a,
      buyerName: 'Tunis Labs',
      issuedBy: OPERATOR.id,
    });
    expect(await entries(`stamp:${issued.id}`)).toEqual([
      ['wallet', -1000],
      ['stamp_duty', 1000],
    ]);
    expect(await ledger.balance(a, 'TND')).toBe(before - 1000n);
    expect(await query(`SELECT line_no, payment_id, amount_minor::int AS amount, vat_minor::int AS vat FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [issued.id])).toEqual([
      { line_no: 1, payment_id: first.id, amount: 50000, vat: 9500 },
      { line_no: 2, payment_id: second.id, amount: 1000000, vat: 190000 },
    ]);

    const [page, statement] = kept('invoices/FAC-2026-000001.pdf');
    expect(page).toEqual(
      expect.arrayContaining([
        'FACTURE',
        'N° FAC-2026-000001',
        'Date : 2 novembre 2026',
        'Période : octobre 2026',
        'Tunis Labs',
        `Compte FF : ${a}`,
        'Total HT | 1 050,000 TND',
        'TVA 19 % | 199,500 TND',
        'Droit de timbre | 1,000 TND',
        'Total TTC | 1 250,500 TND',
        'Crédit prépayé réglé par virement bancaire : 1 249,500 TND, dont 17,735 TND retenus à la source par le client.',
      ]),
    );
    expect(statement).toEqual(expect.arrayContaining(['Relevé de consommation', 'Aucune consommation ce mois-ci.', 'Total HT | 0,000 TND']));
    expect(documents.get('invoices/FAC-2026-000001.pdf')?.contentType).toBe('application/pdf');

    expect((await audit(a)).at(-1)).toMatchObject({
      actor: OPERATOR.id,
      action: 'invoice.issue',
      resource: `invoice:${issued.id}`,
      details: { reason: 'October reviewed', number: 'FAC-2026-000001', month: '2026-10', currency: 'TND', total: '1250.500', stampDuty: '1.000' },
    });
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['owner@tunis-labs.test', 'Your invoice FAC-2026-000001: Tunis Labs']]);

    expect((await invoices.drafts('2026-10', NOV_2)).drafts.filter((draft) => draft.accountId === a)).toEqual([]);
    await expect(invoices.issue(a, '2026-10', 'Again', NOV_2)).rejects.toThrow("Tunis Labs's invoice for 2026-10 was issued: FAC-2026-000001");
    expect(await invoices.forAccount(a)).toEqual([expect.objectContaining({ id: issued.id, number: 'FAC-2026-000001', kind: 'invoice', total: '1250.500', corrects: null })]);
    expect(await invoices.forAccount(b)).toEqual([]);
    expect((await invoices.pdf(issued.id, a)).number).toBe('FAC-2026-000001');
    await expect(invoices.pdf(issued.id, b)).rejects.toThrow(`Invoice ${issued.id} not found`);
  });

  it('gives a month without payments no invoice, and its usage statement, from the hourly sums and charges', async () => {
    const a = await account('Quiet');
    const [{ id: book }] = await query<Array<{ id: string }>>(`SELECT id FROM price_books ORDER BY valid_from LIMIT 1`);
    const fn = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
    const gone = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a';
    await query(`INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, min_instances, duration_ms, billed_ms, status)
                 VALUES (gen_random_uuid(), '2026-10-10T10:05:00Z', '2026-10-10T10:05:01Z', $1, $2, 'hello', 'nodejs', 128, 0, 1000, 1000, 'success')`, [a, fn]);
    const hour = (at: string, functionId: string, requests: number, mbMs: number) =>
      query(
        `INSERT INTO usage_hourly (account_id, hour, function_id, price_book_id, on_demand_requests, on_demand_mb_ms, provisioned_requests, provisioned_mb_ms, provisioned_time_mb_ms, reserved_mb_ms)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0)`,
        [a, at, functionId, book, requests, mbMs],
      );
    await hour('2026-10-10T10:00:00Z', fn, 2_000_000, 512_000_000);
    await hour('2026-10-12T15:00:00Z', fn, 1_000_000, 512_000_000);
    await hour('2026-10-12T15:00:00Z', gone, 1, 128);
    // A function that only held instances, never called this month: its name is the function's.
    const warm = '4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';
    await query(`INSERT INTO functions (id, name, account_id, code, memory, timeout) VALUES ($1, 'warm-only', $2, 'export const handler = () => 1', 128, 5)`, [warm, a]);
    await query(
      `INSERT INTO usage_hourly (account_id, hour, function_id, price_book_id, on_demand_requests, on_demand_mb_ms, provisioned_requests, provisioned_mb_ms, provisioned_time_mb_ms, reserved_mb_ms)
       VALUES ($1, '2026-10-12T15:00:00Z', $2, $3, 0, 0, 0, 0, 1024000, 0)`,
      [a, warm, book],
    );
    const charge = (at: string, amount: number, shadow: boolean) =>
      query(`INSERT INTO usage_charges (account_id, hour, currency, amount_minor, month_to_date_minor, shadow) VALUES ($1, $2, 'TND', $3, $3, $4)`, [a, at, amount, shadow]);
    await charge('2026-10-10T10:00:00Z', 300, true); // shadow mode then
    await charge('2026-10-12T15:00:00Z', 903, false);
    await query(`INSERT INTO rating_runs (hour, accounts, shadow) VALUES ('2026-10-31T23:00:00Z', 1, false) ON CONFLICT DO NOTHING`);

    expect((await invoices.drafts('2026-10', NOV_2)).drafts.map((draft) => draft.accountId)).not.toContain(a);
    await expect(invoices.issue(a, '2026-10', 'Nothing', NOV_2)).rejects.toThrow('Nothing to invoice for Quiet in 2026-10: no payment received by its end waits for an invoice');

    const statement = await invoices.statementIn(db.dataSource.manager, a, '2026-10', NOV_2);
    // 3,000,000 requests and 1,000 GB-s at the first book: 1.8048 + 0.0501334336; the first million requests and every GB-s free.
    expect(statement).toMatchObject({ month: '2026-10', currency: 'TND', usageMinor: 1855n, freeTierMinor: -652n, totalMinor: 1203n, debitedMinor: 903n, shadowMinor: 300n, complete: true });
    expect(statement.functions.map((f) => [f.name, f.requests, f.gbSeconds, f.amountMinor])).toEqual([
      [gone, 1n, '0.000125', 0n], // no call, no row left: its ID, which sorts first
      ['hello', 3_000_000n, '1000', 1855n], // its two hours, its name from its last call
      ['warm-only', 0n, '0', 0n], // a GB-s of instance held, 0.0000125334336 TND
    ]);

    const [page] = pdfRows(await invoices.statementPdf(a, '2026-10', NOV_2)).map((rows) => rows.map((row) => row.replaceAll(NBSP, ' ')));
    expect(page).toEqual(
      expect.arrayContaining([
        'Relevé de consommation',
        'Quiet',
        `Compte FF : ${a}`,
        'hello | 3 000 000 | 1 000 | 1,855 TND',
        'Franchise gratuite | -0,652 TND',
        'Total HT | 1,203 TND',
        'Débité du crédit prépayé : 0,903 TND.',
        "Évalué pendant la période d'essai de la facturation, sans être débité : 0,300 TND.",
      ]),
    );
    await expect(invoices.statementPdf(a, '2026-12', NOV_2)).rejects.toThrow("2026-12 hasn't begun");
  });

  it('numbers invoices issued at the same moment one after the other, without a gap, when one of them fails', async () => {
    const accounts = await Promise.all(['A', 'B', 'C → D', 'E', 'F', 'G'].map((name) => account(`Concurrent ${name}`)));
    for (const id of accounts) await paid(id, '10', '2026-10-10', '11.900');
    const before = await lastNumber('FAC');

    const results = await Promise.allSettled(accounts.map((id) => invoices.issue(id, '2026-10', 'Issued at once', NOV_2)));

    // "→" is no character the PDF's fonts have: that invoice fails after its number was taken, which goes back.
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(String((results[2] as PromiseRejectedResult).reason)).toContain("has a character the PDF's fonts can't write");
    const numbers = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.number] : [])).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5].map((k) => `FAC-2026-${String(before + k).padStart(6, '0')}`));
    expect(await lastNumber('FAC')).toBe(before + 5);
    expect((await invoices.drafts('2026-10', NOV_2)).drafts.map((draft) => draft.accountId)).toContain(accounts[2]); // still to issue
    expect(await ledger.balance(accounts[2], 'TND')).toBe(10000n); // no stamp duty taken
  });

  it('corrects an invoice with credit notes, numbered apart, never giving back more than it charged, moving no money', async () => {
    const a = await account('Credit Labs', ['owner@credit-labs.test']);
    await paid(a, '50', '2026-10-08', '59.500');
    const invoice = await invoices.issue(a, '2026-10', 'October', NOV_2);
    const balance = await ledger.balance(a, 'TND');
    const firstNote = (await lastNumber('AV')) + 1;
    sent.length = 0;

    const note = await as(OPERATOR, () =>
      invoices.creditNote(invoice.id, [{ description: 'Remboursement du crédit non consommé', amount: '20' }], 'Unused credit refunded', new Date('2026-11-05T09:00:00Z')),
    );

    const number = `AV-2026-${String(firstNote).padStart(6, '0')}`;
    expect(note).toMatchObject({ kind: 'credit_note', number, month: null, issuedOn: '2026-11-05', subtotal: '20.000', vat: '3.800', stampDuty: '0.000', total: '23.800', corrects: invoice.number, reason: 'Unused credit refunded', withheld: '0.000' });
    expect(kept(`invoices/${number}.pdf`)[0]).toEqual(
      expect.arrayContaining(["FACTURE D'AVOIR", `N° ${number}`, `Facture corrigée : ${invoice.number}`, 'Remboursement du crédit non consommé | 20,000 TND | 19 % | 3,800 TND', "Total TTC de l'avoir | 23,800 TND", 'Motif : Unused credit refunded']),
    );
    expect((await audit(a)).at(-1)).toMatchObject({ action: 'invoice.credit_note', details: { reason: 'Unused credit refunded', number, corrects: invoice.number, total: '23.800' } });
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['owner@credit-labs.test', `A credit note for your invoice ${invoice.number}: Credit Labs`]]);

    const second = await invoices.creditNote(invoice.id, [{ description: 'Correction', amount: '30', vatPercent: 19 }], 'The rest', new Date('2026-11-06T09:00:00Z'));
    expect([second.number, second.total]).toEqual([`AV-2026-${String(firstNote + 1).padStart(6, '0')}`, '35.700']);
    await expect(invoices.creditNote(invoice.id, [{ description: 'Too much', amount: '0.001' }], 'Over')).rejects.toThrow(
      `${invoice.number}'s credit notes would give back 50.001 TND before tax and 9.500 TND of VAT: it charged 50.000 TND and 9.500 TND`,
    );
    await expect(invoices.creditNote(note.id, [{ description: 'A note of a note', amount: '1' }], 'No')).rejects.toThrow(`${number} is a credit note: a credit note corrects an invoice`);
    await expect(invoices.creditNote(invoice.id, [{ description: 'Another rate', amount: '1', vatPercent: 7 }], 'No')).rejects.toThrow(`lines.0.vatPercent must be a VAT rate of ${invoice.number}: 19`);
    await expect(invoices.creditNote(invoice.id, [{ description: 'Nothing', amount: '0' }], 'No')).rejects.toThrow('lines.0.amount must be more than 0');
    expect(await lastNumber('AV')).toBe(firstNote + 1);
    expect(await ledger.balance(a, 'TND')).toBe(balance);
    expect((await invoices.forAccount(a)).map((document) => [document.number, document.kind, document.corrects])).toEqual([
      [second.number, InvoiceKind.CREDIT_NOTE, invoice.number],
      [number, InvoiceKind.CREDIT_NOTE, invoice.number],
      [invoice.number, InvoiceKind.INVOICE, null],
    ]);
  });

  it('never changes or deletes an issued document, its lines or a tax rate', async () => {
    await expect(query(`UPDATE invoices SET total_minor = 0`)).rejects.toThrow('invoices is append-only: UPDATE refused');
    await expect(query(`DELETE FROM invoice_lines`)).rejects.toThrow('invoice_lines is append-only: DELETE refused');
    await expect(query(`UPDATE tax_rates SET percent = 18`)).rejects.toThrow('tax_rates is append-only: UPDATE refused');
    await expect(query(`TRUNCATE invoice_notices`)).rejects.toThrow('invoice_notices is append-only: TRUNCATE refused');
  });

  it("puts a transfer recorded once its month's invoice was issued on the next month's, issued once that month is over", async () => {
    const a = await account('Late Labs');
    await paid(a, '10', '2026-10-02', '11.900');
    await invoices.issue(a, '2026-10', 'October', NOV_2);
    const late = await paid(a, '20', '2026-10-31', '23.800', '0', '2026-11-04T10:00:00Z');
    const onTime = await account('Last Day Labs');
    await paid(onTime, '10', '2026-10-31', '11.900', '0', '2026-11-01T10:00:00Z');

    const october = (await invoices.drafts('2026-10', new Date('2026-11-04T12:00:00Z'))).drafts.map((draft) => draft.accountId);
    expect(october).not.toContain(a);
    expect(october).toContain(onTime); // received on the month's last day: the month's
    const november = await invoices.drafts('2026-11', new Date('2026-11-04T12:00:00Z'));
    expect(november.issuable).toBe(false);
    expect(november.drafts.find((draft) => draft.accountId === a)?.lines.map((line) => [line.paymentId, line.receivedOn])).toEqual([[late.id, '2026-10-31']]);
    await expect(invoices.issue(a, '2026-11', 'Too soon', new Date('2026-11-30T22:59:00Z'))).rejects.toThrow("2026-11 isn't over in Tunisia");

    const december = await invoices.issue(a, '2026-11', 'November', new Date('2026-11-30T23:00:00Z')); // 1 December in Tunisia
    expect([december.month, december.issuedOn, december.subtotal]).toEqual(['2026-11', '2026-12-01', '20.000']);
  });

  it('takes tax rates as dated data: a new VAT rate from its first day in Tunisia, and no stamp duty before its law', async () => {
    await query(`INSERT INTO tax_rates (kind, valid_from, percent, source) VALUES ('vat', '2030-01-01', 20, 'a test')`);
    const a = await account('Dated');

    const before = await payments.requestProForma(a, '100', new Date('2029-12-31T22:59:00Z'));
    const after = await payments.requestProForma(a, '100', new Date('2029-12-31T23:00:00Z')); // 1 January 2030 in Tunisia

    expect([before.vatPercent, before.vat, after.vatPercent, after.vat]).toEqual([19, '19.000', 20, '20.000']);
    expect([await payments.vatPercentNow(new Date('2026-10-17T12:00:00Z')), await payments.vatPercentNow(new Date('2030-06-01T12:00:00Z'))]).toEqual([19, 20]);
    expect(await stampDutyOn(db.dataSource.manager, '2026-11-02', 'TND')).toBe(1000n);
    await expect(stampDutyOn(db.dataSource.manager, '2022-12-31', 'TND')).rejects.toThrow('No stamp duty applies on 2022-12-31: add one to tax_rates');
  });

  it("tells the operator once that last month's invoices are ready, then that some still aren't, even with two backends", async () => {
    await paid(await account('Waiting Labs'), '10', '2026-10-25', '11.900');

    const ready = await Promise.all([notices().notify(NOV_2), notices().notify(NOV_2)]);

    expect(ready.sort()).toEqual([null, 'ready'].sort());
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['operator@ff.test', 'Invoices to issue: October 2026']]);
    expect(await notices().notify(new Date('2026-11-04T09:00:00Z'))).toBe('reminder');
    expect(await notices().notify(new Date('2026-11-05T09:00:00Z'))).toBeNull();
    expect(sent.map((mail) => mail.subject)).toEqual(['Invoices to issue: October 2026', 'Invoices still to issue: October 2026']);
    expect(await query(`SELECT month, kind FROM invoice_notices ORDER BY sent_at`)).toEqual([
      { month: '2026-10', kind: 'ready' },
      { month: '2026-10', kind: 'reminder' },
    ]);
  });

  it("lists every account's documents for operators, newest first, by account, kind and month, a page at a time", async () => {
    const all = await invoices.forOperators({}, { limit: 500 });
    expect(all.invoices.length).toBeGreaterThan(5);
    expect(all.invoices.every((invoice, index) => index === 0 || invoice.issuedOn <= all.invoices[index - 1].issuedOn)).toBe(true);
    const notes = await invoices.forOperators({ kind: InvoiceKind.CREDIT_NOTE }, { limit: 50 });
    expect(notes.invoices.map((invoice) => invoice.kind)).toEqual([InvoiceKind.CREDIT_NOTE, InvoiceKind.CREDIT_NOTE]);
    const november = await invoices.forOperators({ month: '2026-11' }, { limit: 50 });
    expect(november.invoices.map((invoice) => [invoice.buyerName, invoice.month])).toEqual([['Late Labs', '2026-11']]);
    const one = await invoices.forOperators({}, { limit: 1 });
    const next = await invoices.forOperators({}, { limit: 1, before: one.next as string });
    expect([one.invoices[0].id, next.invoices[0].id]).toEqual([all.invoices[0].id, all.invoices[1].id]);
    expect((await invoices.forOperators({ accountId: all.invoices[0].accountId }, { limit: 50 })).invoices.every((invoice) => invoice.accountId === all.invoices[0].accountId)).toBe(true);
  });
});

/**
 * L2: the admin dashboard's overview against a real PostgreSQL server, in a
 * scratch database dropped after: each figure from rows written as the
 * platform writes them, the transfers and invoices through their own
 * services, and what falls outside today, this month or the last 7 days left
 * out. The overview is worked out at most once a minute.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { Currency } from '../billing/currency.entity';
import { InvoicesService } from '../billing/invoices/invoices.service';
import { LedgerAccountType } from '../billing/ledger/ledger-account.entity';
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { LedgerService } from '../billing/ledger/ledger.service';
import { PaymentsService } from '../billing/payments/payments.service';
import { PriceBook } from '../billing/price-book.entity';
import { PricingService } from '../billing/pricing.service';
import { withRequestContext } from '../common/request-context';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { monthPartitions } from '../usage/usage.service';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { capturingMail } from '../mail/capturing-mail';
import { Mail } from '../mail/mail.service';
import { ObjectStoreService } from '../object-store/object-store.service';
import { AdminStatsService, OVERVIEW_TTL_MS } from './admin-stats.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
/** Now, for every test: 20 November, so last month in Tunisia is October, over, its invoices due. */
const NOW = new Date('2026-11-20T10:00:00Z');
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };

run("the admin dashboard's overview (L2)", () => {
  let db: ScratchDatabase;
  let ledger: LedgerService;
  let payments: PaymentsService;
  let invoices: InvoicesService;
  let stats: AdminStatsService;
  const sent: Mail[] = [];
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);

  const account = async (status: AccountStatus) => {
    const id = String(800000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status, taxId: '7654321/B/A/M/000' });
    return id;
  };
  const fn = (accountId: string, status: FunctionStatus) =>
    db.dataSource.getRepository(Function).save({ name: `fn-${++n}`, accountId, runtime: Runtime.NODEJS, code: 'x', memory: 128, timeout: 5, status });
  /** A call that started then, billed as given. */
  const call = (accountId: string, functionId: string, at: string, status: string, billedMs = 0) =>
    query(
      `INSERT INTO usage_records (request_id, started_at, ended_at, account_id, function_id, function_name, runtime, memory_mb, duration_ms, billed_ms, status)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, 'fn', 'nodejs', 128, $4::numeric, $4::int, $5)`,
      [at, accountId, functionId, billedMs, status],
    );
  /** A pro-forma for this credit, then its transfer, received that day, as an operator records it. */
  const paid = async (accountId: string, credit: string, receivedOn: string, received: string) => {
    const proForma = await payments.requestProForma(accountId, credit, new Date(`${receivedOn}T08:00:00Z`));
    await payments.recordTransfer({ reference: proForma.reference, received, withheld: '0', receivedOn }, 'Bank statement', new Date(`${receivedOn}T18:00:00Z`));
    return proForma;
  };
  /** An hour's usage debited from the wallet, as the hourly rating writes it, with its charge row. */
  const debited = async (accountId: string, hour: string, minor: bigint) => {
    const { transaction } = await ledger.post({
      kind: LedgerTransactionKind.USAGE,
      idempotencyKey: `usage:${accountId}:${hour}`,
      currency: 'TND',
      entries: [
        { account: { wallet: accountId }, amountMinor: -minor },
        { account: { ff: LedgerAccountType.REVENUE }, amountMinor: minor },
      ],
    });
    await query(
      `INSERT INTO usage_charges (account_id, hour, currency, amount_minor, month_to_date_minor, shadow, ledger_transaction_id) VALUES ($1, $2, 'TND', $3, $3, false, $4)`,
      [accountId, hour, minor, transaction.id],
    );
  };
  /** An hour's usage only rated, in shadow mode. */
  const shadow = (accountId: string, hour: string, minor: number) =>
    query(`INSERT INTO usage_charges (account_id, hour, currency, amount_minor, month_to_date_minor, shadow) VALUES ($1, $2, 'TND', $3, $3, true)`, [accountId, hour, minor]);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await monthPartitions(db.dataSource, ['2026-10', '2026-11']);
    const ds = db.dataSource;
    ledger = new LedgerService(ds);
    const documents = new Map<string, Buffer>();
    const storage = {
      putDocument: async (key: string, body: Buffer) => void documents.set(key, body),
      getDocument: async (key: string) => ({ body: documents.get(key), contentType: 'application/pdf' }),
    } as unknown as ObjectStoreService;
    const config = {
      getOrThrow: (key: string) =>
        key === 'mail'
          ? { consoleUrl: 'https://console.ff.example', operatorEmail: 'operator@ff.test', adminUrl: 'https://admin.ff.example' }
          : { seller: { name: 'FF SARL', taxId: '1234567/A/M/000', address: '1 rue du Lac, 1053 Tunis' }, bank: { name: 'Banque', iban: 'TN59 1000 6035 1835 9847 8831', bic: null } },
    } as unknown as ConfigService;
    const audit = new AuditService(ds.getRepository(AuditEntry));
    const mail = capturingMail(sent);
    payments = new PaymentsService(ds, ledger, audit, mail, storage, config);
    invoices = new InvoicesService(ds, ledger, new PricingService(ds.getRepository(PriceBook), ds.getRepository(Currency)), audit, mail, storage, config);
    stats = new AdminStatsService(ds, invoices);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('counts every figure from the platform as it is, and leaves out what is outside today, this month or the last 7 days', async () => {
    // Accounts: four active, two pending, one rejected, one suspended; none closed, which still counts, as 0.
    const [a, b, c, d] = [await account(AccountStatus.ACTIVE), await account(AccountStatus.ACTIVE), await account(AccountStatus.ACTIVE), await account(AccountStatus.ACTIVE)];
    for (const status of [AccountStatus.PENDING, AccountStatus.PENDING, AccountStatus.REJECTED, AccountStatus.SUSPENDED]) await account(status);
    // Functions: one being deleted, which counts no more.
    const f = await fn(a, FunctionStatus.ACTIVE);
    await fn(a, FunctionStatus.ACTIVE);
    await fn(b, FunctionStatus.ERROR);
    await fn(b, FunctionStatus.CREATING);
    await fn(c, FunctionStatus.DELETED);
    // Today's calls: three successes, four failures of each kind, two throttled; and five the rate limit refused.
    for (const status of ['success', 'success', 'success', 'error', 'timeout']) await call(a, f.id, '2026-11-20T08:00:00Z', status, 100);
    for (const status of ['platform_error', 'lost', 'throttled', 'throttled']) await call(a, f.id, '2026-11-20T08:00:00Z', status);
    await query(`INSERT INTO rate_limited_invocations (function_id, minute, account_id, count) VALUES ($1, '2026-11-20T09:00:00Z', $2, 5), ($1, '2026-11-19T09:00:00Z', $2, 9)`, [f.id, a]);
    // Yesterday's calls, and the instances FF held for them: in the capacity, not in today's figures.
    for (let i = 0; i < 5; i++) await call(a, f.id, '2026-11-19T12:00:00Z', 'success', 2048);
    for (let minute = 0; minute < 10; minute++) {
      await query(`INSERT INTO capacity_samples (function_id, minute, account_id, instances, min_instances, memory_mb) VALUES ($1, $2, $3, 1, 1, 128)`, [
        f.id,
        new Date(Date.UTC(2026, 10, 19, 12, minute)),
        a,
      ]);
    }
    // Eight days ago: outside the capacity's 7 days.
    await call(a, f.id, '2026-11-12T12:00:00Z', 'success', 4096);
    // Transfers: October's two, to invoice, one of them invoiced on 2 November; this month's one; a pro-forma not paid.
    await paid(a, '50', '2026-10-05', '59.500');
    await paid(c, '20', '2026-10-10', '23.800');
    await paid(b, '100', '2026-11-03', '119.000');
    await payments.requestProForma(d, '30', new Date('2026-11-04T08:00:00Z'));
    const invoice = await withRequestContext({ requestId: 'issue', actor: OPERATOR }, () => invoices.issue(a, '2026-10', 'Month-end', new Date('2026-11-02T09:00:00Z')));
    // And a credit note correcting it, which moves no money by itself.
    await withRequestContext({ requestId: 'credit-note', actor: OPERATOR }, () =>
      invoices.creditNote(invoice.id, [{ description: 'Correction', amount: '10' }], 'A line was wrong', new Date('2026-11-05T09:00:00Z')),
    );
    // This month's usage: A's debited, B's in shadow mode; October's left out. D in debt.
    await debited(a, '2026-11-05T10:00:00Z', 1500n);
    await shadow(b, '2026-11-06T10:00:00Z', 700);
    await shadow(b, '2026-10-31T23:00:00Z', 999);
    await ledger.post({
      kind: LedgerTransactionKind.ADJUSTMENT,
      idempotencyKey: 'debt:d',
      currency: 'TND',
      entries: [
        { account: { wallet: d }, amountMinor: -4200n },
        { account: { ff: LedgerAccountType.PROMOTIONAL_CREDIT }, amountMinor: 4200n },
      ],
    });

    const overview = await stats.overview(NOW);

    expect(overview).toEqual({
      computedAt: '2026-11-20T10:00:00.000Z',
      accounts: { byStatus: { pending: 2, active: 4, rejected: 1, suspended: 1, closed: 0 }, pendingApprovals: 2 },
      functions: { total: 4, byStatus: { ACTIVE: 2, ERROR: 1, CREATING: 1 } },
      today: { day: '2026-11-20', invocations: 7, errors: 4, throttles: 7 },
      month: '2026-11',
      money: [
        {
          currency: 'TND',
          consumption: { charged: '2.200', debited: '1.500', shadow: '0.700' },
          topUps: { payments: 1, credit: '100.000' },
          // A: 50 less the invoice's 1.000 stamp duty and 1.500 of usage; B 100; C 20. D owes 4.200.
          balances: { owedByFF: '167.500', owedToFF: '4.200', walletsInDebt: 1 },
        },
      ],
      invoices: { month: '2026-11', issued: 1, creditNotes: 1, toIssue: { month: '2026-10', drafts: 1, issuable: true } },
      capacity: [
        ...['14', '15', '16', '17', '18'].map((day) => ({ day: `2026-11-${day}`, reservedGbS: 0, provisionedGbS: 0, billedGbS: 0, requests: 0 })),
        // 10 minutes of one 128 MB instance, its minimum: 75 GB-s; five calls of 2.048 s at 128 MB: 1.28 GB-s.
        { day: '2026-11-19', reservedGbS: 75, provisionedGbS: 75, billedGbS: 1.28, requests: 5 },
        // Five calls billed 100 ms: success, error and timeout are billed; FF's failures and the throttled aren't.
        { day: '2026-11-20', reservedGbS: 0, provisionedGbS: 0, billedGbS: 0.063, requests: 5 },
      ],
    });
  });

  it("counts the invoices of the month in Tunisia, where they are dated: in UTC's last hour of November, December's", async () => {
    const lastHour = await stats.overview(new Date('2026-11-30T23:30:00Z'));

    // November's invoice and credit note, issued on the 2nd and the 5th, are of a month over in Tunisia; its money is UTC's.
    expect([lastHour.month, lastHour.invoices.month, lastHour.invoices.issued, lastHour.invoices.creditNotes, lastHour.invoices.toIssue.month]).toEqual([
      '2026-11',
      '2026-12',
      0,
      0,
      '2026-11',
    ]);
  });

  it('serves the same overview for a minute, then works it out anew', async () => {
    const first = await stats.overview(new Date(NOW.getTime() + 2 * OVERVIEW_TTL_MS));
    await account(AccountStatus.PENDING);

    const soon = await stats.overview(new Date(NOW.getTime() + 2 * OVERVIEW_TTL_MS + 30_000));
    const later = await stats.overview(new Date(NOW.getTime() + 3 * OVERVIEW_TTL_MS));

    expect(soon).toBe(first);
    expect([first.accounts.pendingApprovals, later.accounts.pendingApprovals]).toEqual([2, 3]);
    expect(later.computedAt).toBe(new Date(NOW.getTime() + 3 * OVERVIEW_TTL_MS).toISOString());
  });

  it("keeps no failure: the next request tries again", async () => {
    const broken = new AdminStatsService({ query: () => Promise.reject(new Error('Connection terminated unexpectedly')) } as never, invoices);
    await expect(broken.overview(NOW)).rejects.toThrow('Connection terminated unexpectedly');

    (broken as unknown as { dataSource: unknown }).dataSource = db.dataSource;
    await expect(broken.overview(new Date(NOW.getTime() + 1000))).resolves.toMatchObject({ month: '2026-11' });
  });
});

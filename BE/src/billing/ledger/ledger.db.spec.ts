/**
 * L2: the ledger (client-readiness plan, P-31, D9, parent §8.3) against a
 * real PostgreSQL server, in a scratch database that is dropped after:
 * - the database's own rules, written around the service in SQL: every
 *   transaction sums to zero in each currency, with two entries at least,
 *   checked at commit; nothing is changed or deleted; one wallet per account
 *   and currency, one of each of FF's accounts;
 * - LedgerService: postings, balances, a key's replay and its conflict,
 *   credit grants, the floor;
 * - postings at the same moment: fifty debits on one wallet, one key twenty
 *   times, a floor that thirty debits don't cross.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { QueryRunner } from 'typeorm';
import { Account, AccountStatus } from '../../accounts/entities/account.entity';
import { databaseConfiguration } from '../../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../../database/scratch-database';
import { LedgerAccountType } from './ledger-account.entity';
import { LedgerTransactionKind } from './ledger-transaction.entity';
import { BalanceFloorException, IdempotencyKeyConflictException, LedgerService, Posted } from './ledger.service';
import { FfAccountType, Posting, PostingEntry } from './posting';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const { REVENUE, VAT_PAYABLE, PROVIDER_CLEARING, PROMOTIONAL_CREDIT, STAMP_DUTY } = LedgerAccountType;

run('the ledger (L2, P-31)', () => {
  let db: ScratchDatabase;
  let ledger: LedgerService;
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  async function account(): Promise<string> {
    const id = String(500000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    return id;
  }
  const wallet = (accountId: string, amountMinor: bigint): PostingEntry => ({ account: { wallet: accountId }, amountMinor });
  const ff = (type: FfAccountType, amountMinor: bigint): PostingEntry => ({ account: { ff: type }, amountMinor });
  const key = (what: string) => `${what}:${++n}`;
  /** D9's top-up: the credit to the wallet, 19% VAT on top, the total at the provider. */
  const topUp = (accountId: string, creditMinor: bigint, idempotencyKey = key('konnect')): Posting => ({
    kind: LedgerTransactionKind.TOPUP,
    idempotencyKey,
    currency: 'TND',
    entries: [wallet(accountId, creditMinor), ff(VAT_PAYABLE, (creditMinor * 19n) / 100n), ff(PROVIDER_CLEARING, -creditMinor - (creditMinor * 19n) / 100n)],
  });
  /** An hour of usage, debited (P-32). */
  const usage = (accountId: string, amountMinor: bigint, idempotencyKey = key(`usage:${accountId}`), currency = 'TND'): Posting => ({
    kind: LedgerTransactionKind.USAGE,
    idempotencyKey,
    currency,
    entries: [wallet(accountId, -amountMinor), ff(REVENUE, amountMinor)],
  });
  const transactionsWithKey = async (idempotencyKey: string) =>
    (await query<Array<{ n: number }>>('SELECT count(*)::int AS n FROM ledger_transactions WHERE idempotency_key = $1', [idempotencyKey]))[0].n;
  const walletsOf = async (accountId: string) =>
    (await query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ledger_accounts WHERE account_id = $1`, [accountId]))[0].n;
  /** Statements in one database transaction, as a script would write them around the service: BEGIN … COMMIT. */
  async function inTransaction(statements: (runner: QueryRunner) => Promise<unknown>): Promise<void> {
    const runner = db.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query('BEGIN');
      await statements(runner);
      await runner.query('COMMIT');
    } catch (error) {
      await runner.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }
  }
  /** A ledger account's ID, created through the service's first posting on it. */
  const idOf = async (accountId: string | null, type: LedgerAccountType, currency = 'TND') =>
    (
      await query<Array<{ id: string }>>('SELECT id FROM ledger_accounts WHERE account_id IS NOT DISTINCT FROM $1 AND type = $2 AND currency = $3', [
        accountId,
        type,
        currency,
      ])
    )[0].id;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    // A second currency, with two decimals, for the rules that hold in each currency.
    await query(`INSERT INTO currencies (code, exponent) VALUES ('EUR', 2)`);
    ledger = new LedgerService(db.dataSource);
  });

  afterAll(async () => {
    await db?.drop();
  });

  describe('the database', () => {
    let accountId: string;
    let walletId: string;
    let revenueId: string;
    let eurRevenueId: string;
    const entry = (runner: QueryRunner, transactionId: string, ledgerAccountId: string, amountMinor: number) =>
      runner.query('INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor) VALUES ($1, $2, $3)', [transactionId, ledgerAccountId, amountMinor]);
    const transaction = async (runner: QueryRunner, idempotencyKey: string) =>
      (await runner.query(`INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('adjustment', $1) RETURNING id`, [idempotencyKey]))[0].id as string;

    beforeAll(async () => {
      accountId = await account();
      await ledger.post(usage(accountId, 1n));
      await ledger.post(usage(accountId, 1n, key('eur'), 'EUR'));
      [walletId, revenueId, eurRevenueId] = [await idOf(accountId, LedgerAccountType.WALLET), await idOf(null, REVENUE), await idOf(null, REVENUE, 'EUR')];
    });

    it('refuses, at commit, a transaction whose entries do not sum to zero, and writes none of it', async () => {
      const unbalanced = key('unbalanced');
      await expect(
        inTransaction(async (runner) => {
          const id = await transaction(runner, unbalanced);
          await entry(runner, id, walletId, 5);
          await entry(runner, id, revenueId, -4); // each statement passes: the check waits for the commit
        }),
      ).rejects.toThrow(/^Ledger transaction [0-9a-f-]{36} does not sum to zero: 1 minor units of TND left over$/);

      expect(await transactionsWithKey(unbalanced)).toBe(0);
    });

    it('takes the entries in any order: the sum is checked once all are written', async () => {
      const balanced = key('balanced');
      await inTransaction(async (runner) => {
        const id = await transaction(runner, balanced);
        await entry(runner, id, walletId, -3);
        await entry(runner, id, revenueId, 1);
        await entry(runner, id, revenueId, 2);
      });

      expect(await transactionsWithKey(balanced)).toBe(1);
    });

    it('sums each currency apart: 5 TND against 5 EUR cents is not a balanced transaction', async () => {
      await expect(
        inTransaction(async (runner) => {
          const id = await transaction(runner, key('two-currencies'));
          await entry(runner, id, revenueId, 5);
          await entry(runner, id, eurRevenueId, -5);
        }),
      ).rejects.toThrow(/does not sum to zero: -5 minor units of EUR left over$/);
    });

    it('refuses a transaction without entries, or with one', async () => {
      await expect(inTransaction((runner) => transaction(runner, key('empty')))).rejects.toThrow(/^Ledger transaction [0-9a-f-]{36} has fewer than two entries$/);
      await expect(
        inTransaction(async (runner) => {
          const id = await transaction(runner, key('one-entry'));
          await entry(runner, id, walletId, 5);
        }),
      ).rejects.toThrow('has fewer than two entries');
    });

    it('refuses an entry added later to a transaction that it would unbalance', async () => {
      const posted = await ledger.post(usage(accountId, 7n));

      await expect(inTransaction((runner) => entry(runner, posted.transaction.id, walletId, 1))).rejects.toThrow(
        `Ledger transaction ${posted.transaction.id} does not sum to zero: 1 minor units of TND left over`,
      );
    });

    it('refuses an entry of zero, and keeps every amount exact past 2^53', async () => {
      await expect(
        inTransaction(async (runner) => {
          const id = await transaction(runner, key('zero'));
          await entry(runner, id, walletId, 0);
        }),
      ).rejects.toThrow(/violates check constraint/);

      const huge = 9007199254740993n; // 2^53 + 1: a JavaScript number would read 9007199254740992
      const accountOfHuge = await account();
      await ledger.post({ ...topUp(accountOfHuge, 1n), entries: [wallet(accountOfHuge, huge), ff(PROVIDER_CLEARING, -huge)] });
      expect(await ledger.balance(accountOfHuge, 'TND')).toBe(huge);
    });

    it('never changes, deletes or empties the ledger: a correction is another transaction', async () => {
      for (const table of ['ledger_entries', 'ledger_transactions', 'ledger_accounts']) {
        await expect(query(`UPDATE ${table} SET id = id`)).rejects.toThrow(`${table} is append-only: UPDATE refused`);
        await expect(query(`DELETE FROM ${table}`)).rejects.toThrow(`${table} is append-only: DELETE refused`);
        await expect(query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/is append-only: TRUNCATE refused/);
      }
      expect(await ledger.balance(accountId, 'TND')).toBe(-11n); // -1, -3 and -7: nothing went
    });

    it('keeps one wallet per account and currency, one of each of FF’s accounts per currency, and only the types there are', async () => {
      const insert = (accountIdOrNull: string | null, type: string, currency = 'TND') =>
        query('INSERT INTO ledger_accounts (account_id, type, currency) VALUES ($1, $2, $3)', [accountIdOrNull, type, currency]);

      await expect(insert(accountId, 'wallet')).rejects.toThrow(/duplicate key value violates unique constraint/);
      await expect(insert(null, 'revenue')).rejects.toThrow(/duplicate key value violates unique constraint/);
      await expect(insert(null, 'wallet')).rejects.toThrow(/violates check constraint/); // a wallet is a customer account's
      await expect(insert(accountId, 'revenue')).rejects.toThrow(/violates check constraint/); // FF's accounts belong to no customer
      await expect(insert(null, 'bank')).rejects.toThrow(/violates check constraint/);
      await expect(insert(null, 'stamp_duty', 'USD')).rejects.toThrow(/violates foreign key constraint/); // a currency FF has
      await expect(insert('999999999999', 'wallet')).rejects.toThrow(/violates foreign key constraint/); // an account that exists
    });
  });

  describe('postings', () => {
    it('posts a top-up as D9 books it: the wallet holds the credit, VAT is owed, the provider holds the total', async () => {
      const accountId = await account();

      const posted = await ledger.post(topUp(accountId, 50000n, 'konnect:pay-50'));

      expect(posted).toMatchObject({ created: true, transaction: { kind: 'topup', idempotencyKey: 'konnect:pay-50', metadata: null } });
      expect(posted.transaction.occurredAt).toBeInstanceOf(Date);
      expect(await ledger.balance(accountId, 'TND')).toBe(50000n);
      const rows = await query(
        `SELECT a.type, a.account_id, e.amount_minor::text AS amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
          WHERE e.transaction_id = $1 ORDER BY e.id`,
        [posted.transaction.id],
      );
      expect(rows).toEqual([
        { type: 'wallet', account_id: accountId, amount: '50000' },
        { type: 'vat_payable', account_id: null, amount: '9500' },
        { type: 'provider_clearing', account_id: null, amount: '-59500' },
      ]);
    });

    it('gives the balance as the sum of the wallet’s entries, 0 before the first, in each currency apart', async () => {
      const accountId = await account();
      expect([await ledger.balance(accountId, 'TND'), await ledger.balances(accountId)]).toEqual([0n, []]);

      await ledger.post(topUp(accountId, 20000n));
      await ledger.post(usage(accountId, 8222n));
      await ledger.post(usage(accountId, 125n, key('eur'), 'EUR'));

      expect(await ledger.balance(accountId, 'TND')).toBe(11778n);
      expect(await ledger.balances(accountId)).toEqual([
        { currency: 'EUR', exponent: 2, balanceMinor: -125n },
        { currency: 'TND', exponent: 3, balanceMinor: 11778n },
      ]);
    });

    it('records when the movement happened and its metadata', async () => {
      const accountId = await account();
      const occurredAt = new Date('2026-10-17T10:00:00Z');

      const posted = await ledger.post({ ...usage(accountId, 5n), occurredAt, metadata: { hour: '2026-10-17T10', gbSeconds: '12.5' } });

      expect(posted.transaction).toMatchObject({ occurredAt, metadata: { hour: '2026-10-17T10', gbSeconds: '12.5' } });
      expect(posted.transaction.createdAt.getTime()).toBeGreaterThan(occurredAt.getTime());
    });

    it("answers a key's replay with the first posting, writing nothing: its time and metadata stay the first's", async () => {
      const accountId = await account();
      const first = await ledger.post({ ...topUp(accountId, 10000n, 'konnect:pay-replayed'), metadata: { payment: 'first' } });

      const again = await ledger.post({ ...topUp(accountId, 10000n, 'konnect:pay-replayed'), metadata: { payment: 'retry' }, occurredAt: new Date('2030-01-01T00:00:00Z') });

      expect(again.created).toBe(false);
      expect(again.transaction).toEqual(first.transaction);
      expect(again.transaction.metadata).toEqual({ payment: 'first' });
      expect(again.entries).toEqual(expect.arrayContaining(first.entries));
      expect([await transactionsWithKey('konnect:pay-replayed'), await ledger.balance(accountId, 'TND')]).toEqual([1, 10000n]);
    });

    it('refuses a used key with other entries, another kind or another currency (409), writing nothing', async () => {
      const accountId = await account();
      const first = await ledger.post(usage(accountId, 8222n, `usage:${accountId}:2026-10-17T10`));
      const conflict = `The ledger key usage:${accountId}:2026-10-17T10 was posted before, with other entries, as transaction ${first.transaction.id}: nothing was written`;

      await expect(ledger.post(usage(accountId, 8223n, `usage:${accountId}:2026-10-17T10`))).rejects.toThrow(new IdempotencyKeyConflictException(conflict));
      await expect(ledger.post({ ...usage(accountId, 8222n, `usage:${accountId}:2026-10-17T10`), kind: LedgerTransactionKind.ADJUSTMENT })).rejects.toThrow(conflict);
      await expect(ledger.post(usage(accountId, 8222n, `usage:${accountId}:2026-10-17T10`, 'EUR'))).rejects.toThrow(conflict);
      const other = await account();
      await expect(ledger.post(usage(other, 8222n, `usage:${accountId}:2026-10-17T10`))).rejects.toThrow(conflict);

      expect([await transactionsWithKey(`usage:${accountId}:2026-10-17T10`), await ledger.balance(accountId, 'TND'), await walletsOf(other)]).toEqual([1, -8222n, 0]);
    });

    it('refuses a wrong posting before the database: no wallet is created for it', async () => {
      const accountId = await account();

      await expect(ledger.post({ ...usage(accountId, 5n), entries: [wallet(accountId, -5n), ff(REVENUE, 4n)] })).rejects.toThrow(
        /^Ledger posting usage:\d+:\d+: its entries sum to -1, not 0$/,
      );
      expect(await walletsOf(accountId)).toBe(0);
    });

    it('refuses a wallet for an account that does not exist, writing nothing', async () => {
      const posting = usage('999999999999', 5n);
      await expect(ledger.post(posting)).rejects.toThrow(/violates foreign key constraint/);
      expect(await transactionsWithKey(posting.idempotencyKey)).toBe(0);
    });

    it("writes in the caller's database transaction, and nothing if it rolls back", async () => {
      const accountId = await account();
      const kept = usage(accountId, 5n);
      const dropped = usage(accountId, 7n);

      await db.dataSource.transaction((manager) => ledger.postIn(manager, kept));
      await expect(
        db.dataSource.transaction(async (manager) => {
          await ledger.postIn(manager, dropped);
          throw new Error('the invoice could not be issued');
        }),
      ).rejects.toThrow('the invoice could not be issued');

      expect([await transactionsWithKey(kept.idempotencyKey), await transactionsWithKey(dropped.idempotencyKey), await ledger.balance(accountId, 'TND')]).toEqual([1, 0, -5n]);
    });
  });

  describe('credit grants (for P-74)', () => {
    it('gives a promotion: the wallet up, FF’s promotional credit down by as much, what the credit costs FF', async () => {
      const accountId = await account();
      const before = await ledger.balance(accountId, 'TND');

      const posted = await ledger.grantCredit({
        accountId,
        currency: 'TND',
        amountMinor: 25000n,
        kind: LedgerTransactionKind.PROMO,
        idempotencyKey: `promo:welcome:${accountId}`,
        metadata: { reason: 'Welcome credit' },
      });

      expect(posted.entries).toEqual([wallet(accountId, 25000n), ff(PROMOTIONAL_CREDIT, -25000n)]);
      expect([before, await ledger.balance(accountId, 'TND')]).toEqual([0n, 25000n]);
    });

    it('takes a correction either way, and refuses a promotion that takes credit away', async () => {
      const accountId = await account();
      const grant = (kind: LedgerTransactionKind.PROMO | LedgerTransactionKind.ADJUSTMENT, amountMinor: bigint) =>
        ledger.grantCredit({ accountId, currency: 'TND', amountMinor, kind, idempotencyKey: key('grant') });

      await grant(LedgerTransactionKind.ADJUSTMENT, 3000n);
      await grant(LedgerTransactionKind.ADJUSTMENT, -1000n);
      await expect(grant(LedgerTransactionKind.PROMO, -1000n)).rejects.toThrow('A promotion adds credit: its amount is above 0');

      expect(await ledger.balance(accountId, 'TND')).toBe(2000n);
    });
  });

  describe('the floor', () => {
    it("refuses a debit below it, naming the balance, and writes nothing; a credit passes even when the wallet is below it", async () => {
      const accountId = await account();
      await ledger.post(usage(accountId, 250n)); // a debt of 0.250 TND
      const refused = usage(accountId, 1000n);

      await expect(ledger.post(refused, { floorMinor: -1000n })).rejects.toThrow(
        new BalanceFloorException(accountId, -250n, -1000n, `Account ${accountId} has -0.250 TND: taking 1.000 TND would leave it below -1.000 TND. Nothing was written`),
      );
      await ledger.post(usage(accountId, 750n), { floorMinor: -1000n }); // to the floor exactly
      await ledger.post(topUp(accountId, 500n), { floorMinor: 0n }); // a credit, though the wallet stays below 0

      expect([await transactionsWithKey(refused.idempotencyKey), await ledger.balance(accountId, 'TND')]).toEqual([0, -500n]);
    });

    it('answers a replay without checking the floor again: the first posting was within it', async () => {
      const accountId = await account();
      await ledger.post(topUp(accountId, 1000n));
      const refund = { ...usage(accountId, 1000n), kind: LedgerTransactionKind.REFUND, entries: [wallet(accountId, -1000n), ff(PROVIDER_CLEARING, 1000n)] };

      await ledger.post(refund, { floorMinor: 0n });
      await expect(ledger.post(refund, { floorMinor: 0n })).resolves.toMatchObject({ created: false });
    });
  });

  describe('at the same moment', () => {
    it('takes fifty debits on one wallet, each once, and leaves exactly the balance they should', async () => {
      const accountId = await account();
      await ledger.post(topUp(accountId, 100000n));

      const posted = await Promise.all(Array.from({ length: 50 }, () => ledger.post(usage(accountId, 1234n))));

      expect(posted.every((result) => result.created)).toBe(true);
      expect(await ledger.balance(accountId, 'TND')).toBe(100000n - 50n * 1234n);
    });

    it('creates a new wallet, and FF’s accounts in a new currency, once, when their first postings come together', async () => {
      await query(`INSERT INTO currencies (code, exponent) VALUES ('LYD', 3)`);
      const accountId = await account();

      await Promise.all(Array.from({ length: 20 }, () => ledger.post(usage(accountId, 10n, key('lyd'), 'LYD'))));

      expect(await query(`SELECT type, count(*)::int AS n FROM ledger_accounts WHERE currency = 'LYD' GROUP BY type ORDER BY type`)).toEqual([
        { type: 'revenue', n: 1 },
        { type: 'wallet', n: 1 },
      ]);
      expect(await ledger.balance(accountId, 'LYD')).toBe(-200n);
    });

    it('never deadlocks two postings that create the same two accounts, whatever order their entries list them in', async () => {
      for (const currency of ['QAA', 'QAB', 'QAC', 'QAD', 'QAE']) {
        await query('INSERT INTO currencies (code, exponent) VALUES ($1, 3)', [currency]);
        const accountId = await account();
        const grant = (entries: PostingEntry[]): Posting => ({ kind: LedgerTransactionKind.ADJUSTMENT, idempotencyKey: key('order'), currency, entries });

        await Promise.all([
          ledger.post(grant([wallet(accountId, 5n), ff(PROMOTIONAL_CREDIT, -5n)])),
          ledger.post(grant([ff(PROMOTIONAL_CREDIT, -7n), wallet(accountId, 7n)])),
        ]);

        expect(await ledger.balance(accountId, currency)).toBe(12n);
      }
    });

    it('writes a key posted twenty times at once once: the others are its replays', async () => {
      const accountId = await account();
      const posting = topUp(accountId, 5000n);

      const posted: Posted[] = await Promise.all(Array.from({ length: 20 }, () => ledger.post(posting)));

      expect(posted.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(posted.map((result) => result.transaction.id)).size).toBe(1);
      expect([await transactionsWithKey(posting.idempotencyKey), await ledger.balance(accountId, 'TND')]).toEqual([1, 5000n]);
    });

    it('writes a key once when its postings have no wallet to wait on: FF’s own accounts only', async () => {
      const correction = (idempotencyKey: string): Posting => ({
        kind: LedgerTransactionKind.ADJUSTMENT,
        idempotencyKey,
        currency: 'TND',
        entries: [ff(STAMP_DUTY, -1000n), ff(REVENUE, 1000n)],
      });
      // The accounts exist first: the postings below wait on nothing before they meet at the key.
      await ledger.post(correction(key('stamp-duty-correction')));
      const posting = correction(key('stamp-duty-correction'));

      const posted = await Promise.all(Array.from({ length: 20 }, () => ledger.post(posting)));

      expect(posted.filter((result) => result.created)).toHaveLength(1);
      expect(new Set(posted.map((result) => result.transaction.id)).size).toBe(1);
      expect(await transactionsWithKey(posting.idempotencyKey)).toBe(1);
    });

    it('never crosses a floor: of thirty debits of 1.000 TND on 10.000 TND, ten pass', async () => {
      const accountId = await account();
      await ledger.post(topUp(accountId, 10000n));

      const results = await Promise.allSettled(Array.from({ length: 30 }, () => ledger.post(usage(accountId, 1000n), { floorMinor: 0n })));

      const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      expect([results.length - refused.length, refused.length]).toEqual([10, 20]);
      expect(refused.every((result) => result.reason instanceof BalanceFloorException)).toBe(true);
      expect(await ledger.balance(accountId, 'TND')).toBe(0n);
    });
  });
});

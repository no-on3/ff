/**
 * L2: the balance check and the low-balance e-mails (client-readiness plan,
 * P-33, D9) against a real PostgreSQL server, in a scratch database that is
 * dropped after: the standing from the ledger (the balance, and when it fell
 * below the buffer); the ledger's NOTIFY, at commit and never on a rollback,
 * to every listener; the cached standing refreshed by it, and its minute
 * otherwise; invokes refused once the grace period has run; the e-mails, once
 * per share and credit, to the owners; and the owners' shares.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { PlatformSetting } from '../admin/platform-setting.entity';
import { PlatformSettingsService } from '../admin/platform-settings.service';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/principal';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Mail, MailService } from '../mail/mail.service';
import { BillingService } from './billing.service';
import { InsufficientCreditException } from './credit-policy';
import { CreditService } from './credit.service';
import { LedgerAccountType } from './ledger/ledger-account.entity';
import { LedgerTransactionKind } from './ledger/ledger-transaction.entity';
import { LedgerEvents } from './ledger/ledger-events';
import { LedgerService } from './ledger/ledger.service';
import { LowBalanceService } from './low-balance.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const HOUR = 3_600_000;
const CONSOLE = 'https://console.ff.example';

run('the balance check and the low-balance e-mails (L2, P-33)', () => {
  let db: ScratchDatabase;
  let ledger: LedgerService;
  let events: LedgerEvents;
  let credit: CreditService;
  let lowBalance: LowBalanceService;
  let billing: BillingService;
  let settings: PlatformSettingsService;
  const sent: Mail[] = [];
  const started: Array<{ onModuleDestroy(): unknown }> = [];
  let n = 0;
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);

  async function account(owners: string[] = [], others: Array<[string, Role]> = []): Promise<string> {
    const id = String(700000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    for (const [email, role] of [...owners.map((email): [string, Role] => [email, 'owner']), ...others]) {
      const user = await db.dataSource.getRepository(User).save({ oidcSub: `kc-${email}`, email, name: null });
      await db.dataSource.getRepository(Membership).save({ accountId: id, userId: user.id, role });
    }
    return id;
  }
  /** The name account() gives. */
  const nameOf = (accountId: string) => `Account ${Number(accountId) - 700000000000}`;
  const setting = (key: string, value: unknown) =>
    query(`INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
  /** Resolves once `listener` hears that the account's wallet changed. */
  const heard = (listener: LedgerEvents, accountId: string, ms = 3000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`no NOTIFY for ${accountId} within ${ms} ms`));
      }, ms);
      const stop = listener.subscribe((id) => {
        if (id !== accountId) return;
        clearTimeout(timer);
        stop();
        resolve();
      });
    });
  /** Runs `write`, then waits until the listener has heard the account's wallet change. */
  async function written<T>(accountId: string, write: () => Promise<T>): Promise<T> {
    const told = heard(events, accountId);
    told.catch(() => undefined); // a write that fails never tells: its own error is the one to see
    const result = await write();
    await told;
    return result;
  }
  /** A movement of the wallet, as the ledger writes it, once every listener has heard it. */
  async function move(accountId: string, amountMinor: bigint, kind = amountMinor > 0n ? LedgerTransactionKind.PROMO : LedgerTransactionKind.USAGE): Promise<Date> {
    const posted = await written(accountId, () => ledger.post({
      kind,
      idempotencyKey: `test:${++n}`,
      currency: 'TND',
      entries: [
        { account: { wallet: accountId }, amountMinor },
        { account: { ff: amountMinor > 0n ? LedgerAccountType.PROMOTIONAL_CREDIT : LedgerAccountType.REVENUE }, amountMinor: -amountMinor },
      ],
    }));
    return posted.transaction.createdAt;
  }
  /** A credit written by SQL, as another backend or a script would: the trigger tells every backend too. */
  async function creditBySql(accountId: string, amountMinor: number): Promise<void> {
    const key = `sql:${++n}`;
    await query(`INSERT INTO ledger_accounts (account_id, type, currency) VALUES ($1, 'wallet', 'TND') ON CONFLICT DO NOTHING`, [accountId]);
    await query(`INSERT INTO ledger_accounts (type, currency) VALUES ('promotional_credit', 'TND') ON CONFLICT DO NOTHING`);
    await written(accountId, () =>
      query(
        `WITH t AS (INSERT INTO ledger_transactions (kind, idempotency_key) VALUES ('topup', $3) RETURNING id)
         INSERT INTO ledger_entries (transaction_id, ledger_account_id, amount_minor)
         SELECT t.id, a.id, CASE a.type WHEN 'wallet' THEN $2::bigint ELSE -$2::bigint END FROM t, ledger_accounts a
          WHERE a.currency = 'TND' AND (a.account_id = $1 OR (a.account_id IS NULL AND a.type = 'promotional_credit'))`,
        [accountId, amountMinor, key],
      ),
    );
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    const audit = new AuditService(ds.getRepository(AuditEntry));
    settings = new PlatformSettingsService(ds.getRepository(PlatformSetting), audit);
    ledger = new LedgerService(ds);
    events = new LedgerEvents(ds);
    credit = new CreditService(ds, settings, events);
    const mail = { send: async (message: Mail) => sent.push(message) > 0 } as unknown as MailService;
    const config = { getOrThrow: () => ({ consoleUrl: CONSOLE }) } as unknown as ConfigService;
    lowBalance = new LowBalanceService(ds, ledger, settings, mail, events, config);
    billing = new BillingService(ds, credit, settings, audit);
    await events.onModuleInit();
    credit.onModuleInit();
    started.push(events, credit);
    await setting('billingShadowMode', false);
  });

  afterAll(async () => {
    for (const service of started.reverse()) await service.onModuleDestroy();
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  describe('the standing', () => {
    it('is the balance, and since when it is below the buffer: the stretch below it that goes on now', async () => {
      const a = await account();
      const standing = async () => {
        const { standing: s, decision } = await credit.view(a);
        return [s.balanceMinor, s.belowBufferSince, decision.state];
      };

      await move(a, 5000n);
      expect(await standing()).toEqual([5000n, null, 'ok']);
      await move(a, -5500n);
      expect(await standing()).toEqual([-500n, null, 'ok']); // above -1.000: the buffer covers it
      const fell = await move(a, -1000n);
      expect(await standing()).toEqual([-1500n, fell, 'grace']);
      await move(a, -100n);
      expect(await standing()).toEqual([-1600n, fell, 'grace']); // still the same stretch below
      await move(a, 1000n, LedgerTransactionKind.ADJUSTMENT);
      expect(await standing()).toEqual([-600n, null, 'ok']);
      const fellAgain = await move(a, -2000n);
      expect(await standing()).toEqual([-2600n, fellAgain, 'grace']);
    });

    it('counts from the first entry when the balance never was above the buffer', async () => {
      const a = await account();
      const fell = await move(a, -1001n);

      expect((await credit.view(a)).standing.belowBufferSince).toEqual(fell);
    });
  });

  describe("the ledger's NOTIFY", () => {
    it('tells every backend which wallet changed, when the write commits, whoever wrote it', async () => {
      const other = new LedgerEvents(db.dataSource);
      await other.onModuleInit();
      try {
        const a = await account();
        const both = Promise.all([heard(events, a), heard(other, a)]);
        await creditBySql(a, 1000);
        await both;
      } finally {
        await other.onModuleDestroy();
      }
    });

    it('says nothing of a write that rolls back, nor of FF’s own accounts', async () => {
      const a = await account();
      const words: string[] = [];
      const stop = events.subscribe((id) => words.push(id));
      try {
        await expect(
          db.dataSource.transaction(async (manager) => {
            await ledger.postIn(manager, {
              kind: LedgerTransactionKind.PROMO,
              idempotencyKey: `rolled-back:${a}`,
              currency: 'TND',
              entries: [
                { account: { wallet: a }, amountMinor: 1000n },
                { account: { ff: LedgerAccountType.PROMOTIONAL_CREDIT }, amountMinor: -1000n },
              ],
            });
            throw new Error('the payment was not confirmed after all');
          }),
        ).rejects.toThrow('the payment was not confirmed after all');
        await ledger.post({
          kind: LedgerTransactionKind.ADJUSTMENT,
          idempotencyKey: `ff-only:${a}`,
          currency: 'TND',
          entries: [
            { account: { ff: LedgerAccountType.STAMP_DUTY }, amountMinor: -5n },
            { account: { ff: LedgerAccountType.REVENUE }, amountMinor: 5n },
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(words).toEqual([]);
      } finally {
        stop();
      }
    });
  });

  describe('the cache', () => {
    it('keeps a standing until its wallet changes: the NOTIFY drops it at once', async () => {
      const a = await account();
      await move(a, -3000n);
      expect((await credit.view(a)).standing.balanceMinor).toBe(-3000n); // now cached

      await creditBySql(a, 2500);

      expect((await credit.view(a)).standing.balanceMinor).toBe(-500n);
    });

    it('lasts a minute at most without a word from the ledger', async () => {
      const deaf = new CreditService(db.dataSource, settings, new LedgerEvents(db.dataSource)); // listens to nothing
      const a = await account();
      const now = Date.now();
      expect((await deaf.view(a, new Date(now))).standing.balanceMinor).toBe(0n);
      await move(a, 700n);

      expect((await deaf.view(a, new Date(now + 59_000))).standing.balanceMinor).toBe(0n);
      expect((await deaf.view(a, new Date(now + 60_000))).standing.balanceMinor).toBe(700n);
    });
  });

  describe('admitting an invoke', () => {
    it('admits down to the buffer, then for the grace period, then refuses with 402; credit lets it in again at once', async () => {
      const b = await account();
      await move(b, 1000n);
      const fell = await move(b, -3000n); // -2.000 TND, below -1.000
      const stopAt = new Date(fell.getTime() + 24 * HOUR);

      await expect(credit.admit(b, new Date(stopAt.getTime() - 1))).resolves.toBeUndefined();
      const refusal = credit.admit(b, stopAt);
      await expect(refusal).rejects.toBeInstanceOf(InsufficientCreditException);
      await expect(refusal).rejects.toThrow(`Invokes stopped at ${stopAt.toISOString().slice(0, 16).replace('T', ' ')} UTC: the account's balance is -2.000 TND`);

      await creditBySql(b, 1500); // -0.500 TND: above the buffer
      await expect(credit.admit(b, new Date(stopAt.getTime() + 48 * HOUR))).resolves.toBeUndefined();
    });

    it('refuses nothing in shadow mode, and follows the settings as they change', async () => {
      const c = await account();
      const fell = await move(c, -5000n);
      const later = new Date(fell.getTime() + 100 * HOUR);
      try {
        await setting('billingShadowMode', true);
        await expect(credit.admit(c, later)).resolves.toBeUndefined();
        await setting('billingShadowMode', false);
        await setting('negativeBuffer', '6.000');
        await expect(credit.admit(c, later)).resolves.toBeUndefined(); // -5.000 is within a 6.000 buffer: cached so
        await setting('negativeBuffer', '1.000');
        await expect(credit.admit(c, later)).rejects.toBeInstanceOf(InsufficientCreditException); // read again for the new buffer
        await setting('gracePeriodHours', 200);
        await expect(credit.admit(c, later)).resolves.toBeUndefined();
        await setting('gracePeriodHours', 24);
        await expect(credit.admit(c, later)).rejects.toBeInstanceOf(InsufficientCreditException);
      } finally {
        await query(`DELETE FROM platform_settings WHERE key IN ('negativeBuffer', 'gracePeriodHours')`);
        await setting('billingShadowMode', false);
      }
    });

    it('shows nothing below the buffer in shadow mode, where nothing is refused', async () => {
      const e = await account();
      const fell = await move(e, -5000n);
      try {
        await setting('billingShadowMode', true);
        expect((await billing.balance(e, new Date(fell.getTime() + 100 * HOUR))).credit).toEqual({ state: 'ok', buffer: '1.000', belowBufferSince: null, invokesStopAt: null });
      } finally {
        await setting('billingShadowMode', false);
      }
    });

    it('shows the account where it stands, in its balance', async () => {
      const d = await account();
      const fell = await move(d, -1500n);

      const balance = await billing.balance(d, new Date(fell.getTime() + HOUR));

      expect(balance).toMatchObject({
        balance: '-1.500',
        shadowMode: false,
        credit: { state: 'grace', buffer: '1.000', belowBufferSince: fell, invokesStopAt: new Date(fell.getTime() + 24 * HOUR) },
      });
    });
  });

  describe('the low-balance e-mails', () => {
    it("e-mails the owners once per share of the last credit as the balance falls, the lowest share reached when several are", async () => {
      const a = await account(['owner-1@ff.test', 'owner-2@ff.test'], [['dev@ff.test', 'developer']]);
      await move(a, 50000n); // the credit: 50.000 TND

      await move(a, -24000n); // 26.000: above 50%
      expect(await lowBalance.check(a)).toBeNull();
      await move(a, -1000n); // 25.000: 50%
      expect(await lowBalance.check(a)).toBe(50);
      expect(await lowBalance.check(a)).toBeNull(); // once
      await move(a, -24000n); // 1.000: past 20% too
      expect(await lowBalance.check(a)).toBe(20);
      await move(a, -1500n); // -0.500: run out
      expect(await lowBalance.check(a)).toBe(0);

      const name = nameOf(a);
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([
        ['owner-1@ff.test', `Your FF credit is down to 50%: ${name}`],
        ['owner-2@ff.test', `Your FF credit is down to 50%: ${name}`],
        ['owner-1@ff.test', `Your FF credit is down to 20%: ${name}`],
        ['owner-2@ff.test', `Your FF credit is down to 20%: ${name}`],
        ['owner-1@ff.test', `Your FF credit has run out: ${name}`],
        ['owner-2@ff.test', `Your FF credit has run out: ${name}`],
      ]); // the developer gets none
      expect(await query(`SELECT percent, balance_minor::int AS balance FROM low_balance_notices WHERE account_id = $1 ORDER BY percent DESC`, [a])).toEqual([
        { percent: 50, balance: 25000 },
        { percent: 20, balance: 1000 },
        { percent: 0, balance: -500 },
      ]);
    });

    it('starts again from the next credit, and follows the shares the owners set', async () => {
      const a = await account(['owner-3@ff.test']);
      await move(a, 10000n);
      await move(a, -9000n); // 1.000 of 10.000
      expect(await lowBalance.check(a)).toBe(20); // 50% and 20% at once: the lowest named
      await query(`UPDATE accounts SET low_balance_percents = '{80,30}' WHERE id = $1`, [a]);
      await move(a, 4000n, LedgerTransactionKind.TOPUP); // the next credit: 4.000, the balance 5.000

      expect(await lowBalance.check(a)).toBeNull();
      await move(a, -1800n); // 3.200: 80% of 4.000
      expect(await lowBalance.check(a)).toBe(80);
      expect(sent.map((mail) => mail.subject.replace(/: Account \d+$/, ''))).toEqual(['Your FF credit is down to 20%', 'Your FF credit is down to 80%']);
    });

    it('counts from a credit only: a charge given back is none', async () => {
      const a = await account(['owner-7@ff.test']);
      const credited = await move(a, 10000n);
      await move(a, -9000n); // 1.000 of 10.000: 50% and 20%
      expect(await lowBalance.check(a)).toBe(20);
      await move(a, 100n, LedgerTransactionKind.USAGE); // the hourly rating gives back 0.100: not a credit

      await move(a, -1100n); // 0.000 of the 10.000
      expect(await lowBalance.check(a)).toBe(0);
      expect(sent.at(-1)?.text.split('\n')[0]).toBe(`The balance of your account "${nameOf(a)}" (${a}) is 0.000 TND: your last credit, 10.000 TND on ${credited.toISOString().slice(0, 10)}, is used up.`);
    });

    it('sends nothing without a credit to count from, or with no share at all', async () => {
      const a = await account(['owner-4@ff.test']);
      await move(a, -5000n);
      expect(await lowBalance.check(a)).toBeNull();
      await move(a, 1000n);
      await query(`UPDATE accounts SET low_balance_percents = '{}' WHERE id = $1`, [a]);
      expect(await lowBalance.check(a)).toBeNull();
      expect(sent).toEqual([]);
    });

    it('e-mails once when two backends hear the same write', async () => {
      const a = await account(['owner-5@ff.test']);
      await move(a, 2000n);
      await move(a, -1600n); // 0.400 of 2.000: 50% and 20%

      const other = new LowBalanceService(db.dataSource, ledger, settings, { send: async (message: Mail) => sent.push(message) > 0 } as unknown as MailService, events, {
        getOrThrow: () => ({ consoleUrl: CONSOLE }),
      } as unknown as ConfigService);
      const results = await Promise.all([lowBalance.check(a), other.check(a)]);

      expect(results.filter((percent) => percent !== null)).toEqual([20]);
      expect(sent).toHaveLength(1);
    });

    it('checks by itself after each write it hears', async () => {
      lowBalance.onModuleInit();
      started.push(lowBalance);
      const a = await account(['owner-6@ff.test']);
      await move(a, 1000n);

      await move(a, -1000n); // 0.000: every share

      for (let wait = 0; wait < 50 && sent.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([['owner-6@ff.test', `Your FF credit has run out: ${nameOf(a)}`]]);
    });
  });

  describe("the owners' shares", () => {
    it("are FF's until an owner sets them; checked, kept with the change in the audit log, and null for FF's again", async () => {
      const a = await account();
      expect(await billing.alerts(a)).toEqual({ lowBalancePercents: null, defaultPercents: [50, 20, 0] });

      expect(await billing.setAlerts(a, { lowBalancePercents: [80, 10] })).toEqual({ lowBalancePercents: [80, 10], defaultPercents: [50, 20, 0] });
      await billing.setAlerts(a, { lowBalancePercents: [80, 10] }); // the same: nothing written
      await billing.setAlerts(a, { lowBalancePercents: null });

      const entries = await db.dataSource.getRepository(AuditEntry).find({ where: { accountId: a, action: 'billing.alerts' }, order: { id: 'ASC' } });
      expect(entries.map((entry) => entry.details)).toEqual([
        { changes: { lowBalancePercents: { from: null, to: [80, 10] } } },
        { changes: { lowBalancePercents: { from: [80, 10], to: null } } },
      ]);
      await expect(billing.setAlerts(a, { lowBalancePercents: [10, 80] })).rejects.toMatchObject({
        response: { message: ['lowBalancePercents: must go from the largest share to the smallest, each once'] },
      });
      await expect(billing.setAlerts(a, { lowBalancePercents: [101, 2, 3, 4, 5, 6] })).rejects.toMatchObject({ status: 400 });
      expect((await billing.alerts(a)).lowBalancePercents).toBeNull();
    });
  });
});

/**
 * L2: credit grants and the account page's credit (client-readiness plan,
 * P-74) against a real PostgreSQL server, in a scratch database that is
 * dropped after: each grant's ledger entries and audit entry in one
 * transaction, the owners' e-mail; a retry, two at once, a key used again;
 * the floor of a correction and the debt left on purpose; the large-credit
 * threshold (D12); what each status takes; the credit state read as it is
 * now; a stopped account invoking again; this month's charges.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import type { Role } from '../auth/principal';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { LedgerAccountType } from '../billing/ledger/ledger-account.entity';
import { LedgerEvents } from '../billing/ledger/ledger-events';
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { BalanceFloorException, LedgerService } from '../billing/ledger/ledger.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Mail, MailService } from '../mail/mail.service';
import { AdminCreditsService, GrantInput } from './admin-credits.service';
import { PlatformSetting } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };
const CONSOLE = 'https://console.ff.example';
const HOUR_MS = 3_600_000;
const { PROMO, ADJUSTMENT } = LedgerTransactionKind;

run('credit grants, for operators (L2, P-74)', () => {
  let db: ScratchDatabase;
  let service: AdminCreditsService;
  let ledger: LedgerService;
  let settings: PlatformSettingsService;
  /** The invoke check's service, deaf to the ledger: what it caches stays, as when the ledger's word comes late. */
  let deaf: CreditService;
  const sent: Mail[] = [];
  let failMail = false;
  let n = 0;

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  // In English, as the e-mails these tests read.
  const user = (name: string) => db.dataSource.getRepository(User).save({ oidcSub: `kc-${name}-${++n}`, email: `${name}-${n}@ff.test`, name: null, locale: 'en' });
  /** An account, with its members. */
  async function account(fields: Partial<Account> = {}, members: Array<[User, Role]> = []): Promise<string> {
    const id = String(400000000000 + ++n);
    // A closed account always has the date its data is deleted, as closing it sets one.
    const closed = fields.status === AccountStatus.CLOSED ? { dataDeletionDueAt: new Date(Date.now() + 30 * 86_400_000) } : {};
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE, ...closed, ...fields });
    for (const [member, role] of members) await db.dataSource.getRepository(Membership).save({ accountId: id, userId: member.id, role });
    return id;
  }
  const grantOf = (fields: Partial<GrantInput> = {}): GrantInput => ({ kind: PROMO, amount: '10', reason: 'Welcome credit', idempotencyKey: randomUUID(), ...fields });
  const balance = async (id: string) => ledger.balance(id, 'TND');
  const entriesOf = (accountId: string) => db.dataSource.getRepository(AuditEntry).find({ where: { accountId }, order: { id: 'ASC' } });
  const transactionsWithKey = async (key: string) =>
    Number((await query<Array<{ n: string }>>('SELECT count(*) AS n FROM ledger_transactions WHERE idempotency_key = $1', [`grant:${key}`]))[0].n);
  /** A usage debit, as the hourly rating writes it. */
  const debit = (accountId: string, amountMinor: bigint) =>
    ledger.post({
      kind: LedgerTransactionKind.USAGE,
      idempotencyKey: `usage:${accountId}:${++n}`,
      currency: 'TND',
      entries: [
        { account: { wallet: accountId }, amountMinor: -amountMinor },
        { account: { ff: LedgerAccountType.REVENUE }, amountMinor },
      ],
    });
  /** Runs the test with these settings, then puts the defaults back. */
  async function withSettings(changes: Record<string, unknown>, test: () => Promise<void>): Promise<void> {
    await settings.update(changes, 'Set for the test');
    try {
      await test();
    } finally {
      await settings.update({ largeCreditThreshold: '100.000', billingShadowMode: true, gracePeriodHours: 24 }, 'Defaults again');
    }
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const ds = db.dataSource;
    const audit = new AuditService(ds.getRepository(AuditEntry));
    // As the request context would name the operator: the audit service takes the actor from it.
    const record = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementation((event, manager) => record({ actor: OPERATOR, ...event }, manager));
    settings = new PlatformSettingsService(ds.getRepository(PlatformSetting), audit);
    ledger = new LedgerService(ds);
    deaf = new CreditService(ds, settings, new LedgerEvents(ds));
    const config = { getOrThrow: () => ({ consoleUrl: CONSOLE }) } as unknown as ConfigService;
    const mail = Object.assign(Object.create(MailService.prototype) as MailService, {
      send: async (message: Mail) => {
        if (failMail) throw new Error('the mail server is down');
        return sent.push(message) > 0;
      },
    });
    service = new AdminCreditsService(ds, ledger, deaf, settings, audit, mail, config);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
    failMail = false;
  });

  describe('a promotion', () => {
    it("moves the wallet up and FF's promotional credit down, with its audit entry; the owners are told, not the other members", async () => {
      const [owner, developer, viewer] = [await user('owner'), await user('developer'), await user('viewer')];
      const id = await account({ name: 'Tunis Labs' }, [[owner, 'owner'], [developer, 'developer'], [viewer, 'viewer']]);
      const key = randomUUID();

      const grant = await service.grant(id, { kind: PROMO, amount: '25', reason: 'Welcome credit for the pilot', idempotencyKey: key });

      expect(grant).toEqual({ id: expect.any(String), kind: 'promo', currency: 'TND', amount: '25.000', balance: '25.000', createdAt: expect.any(Date), replayed: false });
      expect(await query('SELECT kind, idempotency_key, metadata FROM ledger_transactions WHERE id = $1', [grant.id])).toEqual([
        { kind: 'promo', idempotency_key: `grant:${key}`, metadata: { reason: 'Welcome credit for the pilot' } },
      ]);
      expect(
        await query(
          `SELECT a.account_id, a.type, e.amount_minor::text AS amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
            WHERE e.transaction_id = $1 ORDER BY e.amount_minor`,
          [grant.id],
        ),
      ).toEqual([
        { account_id: null, type: LedgerAccountType.PROMOTIONAL_CREDIT, amount: '-25000' },
        { account_id: id, type: LedgerAccountType.WALLET, amount: '25000' },
      ]);
      expect((await entriesOf(id)).map(({ actor, actorLabel, action, resource, details }) => ({ actor, actorLabel, action, resource, details }))).toEqual([
        {
          actor: OPERATOR.id,
          actorLabel: OPERATOR.label,
          action: 'credit.promo',
          resource: `ledger_transaction:${grant.id}`,
          details: { reason: 'Welcome credit for the pilot', kind: 'promo', currency: 'TND', amount: '25.000', balance: '25.000' },
        },
      ]);
      expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([[owner.email, 'FF added credit to your account: Tunis Labs']]);
      expect(sent[0].text).toContain(`FF added 25.000 TND of credit to your account "Tunis Labs" (${id}).\nWhy: Welcome credit for the pilot\nThe balance is now 25.000 TND.`);
    });

    it('goes to a pending or suspended account; not to a rejected or closed one, where a correction still settles the balance', async () => {
      for (const status of [AccountStatus.PENDING, AccountStatus.SUSPENDED]) {
        expect((await service.grant(await account({ status }), grantOf())).balance).toBe('10.000');
      }
      for (const status of [AccountStatus.REJECTED, AccountStatus.CLOSED]) {
        const id = await account({ status });
        await debit(id, 2500n);

        await expect(service.grant(id, grantOf())).rejects.toThrow(
          new ConflictException(`Account ${id} is ${status}: it gets no promotional credit. A correction can still settle its balance`),
        );
        expect(await balance(id)).toBe(-2500n);

        const settled = await service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '2.5', reason: 'Small debt written off at closing' }));
        expect([settled.balance, await balance(id), (await entriesOf(id)).map((entry) => entry.action)]).toEqual(['0.000', 0n, ['credit.adjustment']]);
      }
    });

    it('refuses an account that does not exist, writing nothing', async () => {
      const key = randomUUID();

      await expect(service.grant('000000000999', grantOf({ idempotencyKey: key }))).rejects.toThrow(new NotFoundException('Account 000000000999 not found'));
      expect(await transactionsWithKey(key)).toBe(0);
    });

    it('stands when the e-mail fails: the credit is granted and recorded', async () => {
      const owner = await user('owner');
      const id = await account({}, [[owner, 'owner']]);
      failMail = true;

      const grant = await service.grant(id, grantOf());

      expect([grant.replayed, await balance(id), (await entriesOf(id)).length, sent.length]).toEqual([false, 10000n, 1, 0]);
    });
  });

  describe('the key', () => {
    it('makes a retry grant once: the first grant again, replayed, with no second entry or e-mail', async () => {
      const owner = await user('owner');
      const id = await account({}, [[owner, 'owner']]);
      const input = grantOf({ amount: '12.5' });
      const first = await service.grant(id, input);
      sent.length = 0;

      const again = await service.grant(id, { ...input, reason: 'The same grant, sent again' });

      expect(again).toEqual({ ...first, replayed: true });
      expect([await transactionsWithKey(input.idempotencyKey), await balance(id), (await entriesOf(id)).length, sent.length]).toEqual([1, 12500n, 1, 0]);
    });

    it('makes the same grant sent twice at once grant once', async () => {
      const owner = await user('owner');
      const id = await account({}, [[owner, 'owner']]);
      const input = grantOf({ amount: '7' });

      const both = await Promise.all([service.grant(id, input), service.grant(id, input)]);

      expect(both.map((grant) => grant.replayed).sort()).toEqual([false, true]);
      expect(both[0].id).toBe(both[1].id);
      expect([await balance(id), (await entriesOf(id)).length, sent.length]).toEqual([7000n, 1, 1]);
    });

    it('refuses a key granted before with another amount, or to another account, writing nothing', async () => {
      const id = await account();
      const input = grantOf({ amount: '10' });
      await service.grant(id, input);

      await expect(service.grant(id, { ...input, amount: '11' })).rejects.toThrow(
        new ConflictException(`idempotencyKey ${input.idempotencyKey} was used for another grant: nothing was written. Each grant takes a key of its own`),
      );
      await expect(service.grant(await account(), input)).rejects.toThrow('was used for another grant'); // another account's
      expect([await balance(id), (await entriesOf(id)).length]).toEqual([10000n, 1]);
    });
  });

  describe('a correction', () => {
    it('takes the credit left at most: beyond it, refused with the balance named, writing nothing', async () => {
      const owner = await user('owner');
      await db.dataSource.query(`UPDATE "users" SET "locale" = 'fr-TN' WHERE "email" = $1`, [owner.email]); // and this owner's e-mails in French
      const id = await account({ name: 'Floor' }, [[owner, 'owner']]);
      await service.grant(id, grantOf({ amount: '10' }));
      sent.length = 0;

      await expect(service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '-10.001' }))).rejects.toThrow(
        new BalanceFloorException(id, 10000n, 0n, `Account ${id} has 10.000 TND: taking 10.001 TND would leave it below 0.000 TND. Nothing was written`),
      );
      expect([await balance(id), (await entriesOf(id)).length, sent.length]).toEqual([10000n, 1, 0]);

      const taken = await service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '-10', reason: 'Transfer recorded twice' }));

      expect([taken.amount, taken.balance, await balance(id)]).toEqual(['-10.000', '0.000', 0n]);
      expect((await entriesOf(id)).at(-1)).toMatchObject({
        action: 'credit.adjustment',
        details: { reason: 'Transfer recorded twice', kind: 'adjustment', currency: 'TND', amount: '-10.000', balance: '0.000' },
      });
      expect(sent.map((mail) => mail.subject)).toEqual(['FF a corrigé votre crédit : Floor']);
      expect(sent[0].text).toContain(': 10,000\u00a0TND retirés.');
    });

    it('leaves a debt only when asked, which the ledger and the audit entry say', async () => {
      const id = await account();
      await service.grant(id, grantOf({ amount: '1' }));

      const debt = await service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '-3', allowDebt: true, reason: 'Transfer recorded at ten times its amount' }));

      expect([debt.balance, await balance(id)]).toEqual(['-2.000', -2000n]);
      expect(await query('SELECT metadata FROM ledger_transactions WHERE id = $1', [debt.id])).toEqual([
        { metadata: { reason: 'Transfer recorded at ten times its amount', allowDebt: true } },
      ]);
      expect((await entriesOf(id)).at(-1)?.details).toEqual({ reason: 'Transfer recorded at ten times its amount', kind: 'adjustment', currency: 'TND', amount: '-3.000', balance: '-2.000', allowDebt: true });

      // On credit that adds, it means nothing, and isn't recorded.
      const added = await service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '2', allowDebt: true }));
      expect((await entriesOf(id)).at(-1)?.details).not.toHaveProperty('allowDebt');
      expect(await query('SELECT metadata FROM ledger_transactions WHERE id = $1', [added.id])).toEqual([{ metadata: { reason: 'Welcome credit' } }]);
    });
  });

  describe('the large-credit threshold (D12)', () => {
    it('asks for the amount again above it, either way; at it, nothing more', async () => {
      const id = await account();
      const above = grantOf({ amount: '100.001' });

      await expect(service.grant(id, above)).rejects.toThrow(
        new BadRequestException('100.001 TND is above the large-credit threshold, 100.000 TND: type the amount again as confirmAmount to grant it (D12)'),
      );
      expect([await transactionsWithKey(above.idempotencyKey), (await entriesOf(id)).length]).toEqual([0, 0]);

      await expect(service.grant(id, { ...above, confirmAmount: '100.01' })).rejects.toThrow(
        new BadRequestException('confirmAmount is 100.010, not the amount, 100.001: nothing was granted'),
      );
      expect((await service.grant(id, { ...above, confirmAmount: '100.001' })).balance).toBe('100.001');
      expect((await service.grant(id, grantOf({ amount: '100' }))).balance).toBe('200.001');

      await expect(service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '-150' }))).rejects.toThrow('150.000 TND is above the large-credit threshold');
      expect((await service.grant(id, grantOf({ kind: ADJUSTMENT, amount: '-150', confirmAmount: '-150.000' }))).balance).toBe('50.001');
    });

    it("is the platform setting's, as it is at the moment", async () => {
      const id = await account();
      await withSettings({ largeCreditThreshold: '20.000' }, async () => {
        await expect(service.grant(id, grantOf({ amount: '20.5' }))).rejects.toThrow('20.500 TND is above the large-credit threshold, 20.000 TND');
        expect((await service.grant(id, grantOf({ amount: '20' }))).balance).toBe('20.000');
      });
      expect((await service.grant(id, grantOf({ amount: '20.5' }))).balance).toBe('40.500');
    });
  });

  it('names the field of an amount that is not one, before anything is written', async () => {
    const id = await account();

    await expect(service.grant(id, grantOf({ amount: '1.0001' }))).rejects.toThrow(
      new BadRequestException('amount: "1.0001" is not an amount with 3 decimals at most, such as 50.000'),
    );
    await expect(service.grant(id, grantOf({ amount: '5', confirmAmount: '5.0001' }))).rejects.toThrow(
      new BadRequestException('confirmAmount: "5.0001" is not an amount with 3 decimals at most, such as 50.000'),
    );
    await expect(service.grant(id, grantOf({ amount: '0' }))).rejects.toThrow(new BadRequestException('amount must not be 0: a grant moves the balance'));
    await expect(service.grant(id, grantOf({ amount: '-5' }))).rejects.toThrow('A promotion adds credit: its amount is above 0');
    expect([await balance(id), (await entriesOf(id)).length]).toEqual([0n, 0]);
  });

  describe("the account page's credit", () => {
    it('reads the balance as it is now, not as the invoke check cached it: a stopped account is ok once credit comes', async () => {
      await withSettings({ billingShadowMode: false, gracePeriodHours: 1 }, async () => {
        const id = await account();
        await debit(id, 5000n);
        // Two hours on, the debt has been below the 1.000 TND buffer for longer than the grace period.
        const later = new Date(Date.now() + 2 * HOUR_MS);
        await expect(deaf.admit(id, later)).rejects.toThrow(InsufficientCreditException); // and it caches the standing
        const stopped = await service.view(id, later);
        expect(stopped).toMatchObject({ balance: '-5.000', shadowMode: false, state: { state: 'stopped', buffer: '1.000' } });
        expect(stopped.state.invokesStopAt?.getTime()).toBe((stopped.state.belowBufferSince as Date).getTime() + HOUR_MS);

        await service.grant(id, grantOf({ amount: '10' }));

        // The invoke check's cache, which never heard the grant, still has the debt...
        expect((await deaf.view(id, later)).standing.balanceMinor).toBe(-5000n);
        // ...and the page doesn't read it.
        expect(await service.view(id, later)).toMatchObject({ balance: '5.000', state: { state: 'ok', buffer: '1.000', belowBufferSince: null, invokesStopAt: null } });
      });
    });

    it('lets a stopped account invoke again as soon as the ledger tells the invoke check (P-33)', async () => {
      await withSettings({ billingShadowMode: false, gracePeriodHours: 1 }, async () => {
        const events = new LedgerEvents(db.dataSource);
        await events.onModuleInit();
        const listening = new CreditService(db.dataSource, settings, events);
        listening.onModuleInit();
        try {
          const id = await account();
          await debit(id, 5000n);
          const later = new Date(Date.now() + 2 * HOUR_MS);
          await expect(listening.admit(id, later)).rejects.toThrow(InsufficientCreditException);
          const told = new Promise<void>((resolve) => {
            const stop = events.subscribe((accountId) => accountId === id && (stop(), resolve()));
          });

          await service.grant(id, grantOf({ amount: '10' }));
          await told;

          await expect(listening.admit(id, later)).resolves.toBeUndefined();
        } finally {
          listening.onModuleDestroy();
          await events.onModuleDestroy();
        }
      });
    });

    it("gives this month's charges, debited and only rated apart, and until when usage is rated; other months and accounts left out", async () => {
      const id = await account();
      const other = await account();
      const charge = (accountId: string, hour: string, amountMinor: number, shadow: boolean) =>
        query(
          `INSERT INTO usage_charges (account_id, hour, currency, amount_minor, month_to_date_minor, shadow) VALUES ($1, $2, 'TND', $3, $3, $4)`,
          [accountId, hour, amountMinor, shadow],
        );
      await charge(id, '2026-09-30T23:00:00Z', 999, false); // last month
      await charge(id, '2026-10-01T00:00:00Z', 1200, false);
      await charge(id, '2026-10-17T10:00:00Z', 34, false);
      await charge(id, '2026-10-17T11:00:00Z', 300, true); // shadow mode was turned on
      await charge(other, '2026-10-17T11:00:00Z', 5000, false);
      await query(`INSERT INTO rating_runs (hour, accounts, shadow) VALUES ('2026-10-17T11:00:00Z', 2, true)`);

      const view = await service.view(id, new Date('2026-10-17T12:30:00Z'));

      expect(view).toEqual({
        currency: 'TND',
        balance: '0.000',
        state: { state: 'ok', buffer: '1.000', belowBufferSince: null, invokesStopAt: null },
        shadowMode: true,
        month: '2026-10',
        debited: '1.234',
        ratedOnly: '0.300',
        ratedUntil: new Date('2026-10-17T12:00:00Z'),
        largeCreditThreshold: '100.000',
      });
      expect((await service.view(other, new Date('2026-09-15T00:00:00Z'))).debited).toBe('0.000');
    });
  });
});

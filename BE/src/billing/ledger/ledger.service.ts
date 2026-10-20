import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { formatMinor } from '../money';
import { LedgerAccountType } from './ledger-account.entity';
import { LedgerTransaction, LedgerTransactionKind } from './ledger-transaction.entity';
import { FfAccountType, LedgerAccountRef, Posting, PostingEntry, postingProblem, refKey, sameEntries } from './posting';

/** A key posted before, with other entries: the first posting stands, and nothing is written. */
export class IdempotencyKeyConflictException extends ConflictException {}

/** A wallet that the posting lowers would end below the floor: nothing is written. */
export class BalanceFloorException extends ConflictException {
  constructor(
    readonly accountId: string,
    readonly balanceMinor: bigint,
    readonly floorMinor: bigint,
    message: string,
  ) {
    super(message);
  }
}

export interface PostOptions {
  /**
   * The least, in minor units, that a wallet this posting lowers may end at:
   * 0n, so that a refund or a correction against a customer never takes more
   * than the credit left, even with a usage debit at the same moment.
   * Without it a wallet may go below zero: usage that has happened is
   * debited whatever the balance (D9).
   */
  floorMinor?: bigint;
}

export interface Posted {
  /** False for a replay: the key was posted before, with the same entries, and nothing was written. */
  created: boolean;
  transaction: LedgerTransaction;
  entries: PostingEntry[];
}

/** A wallet's balance, in its currency's minor units. */
export interface WalletBalance {
  currency: string;
  /** The digits of the currency's minor unit: 3 for TND. */
  exponent: number;
  balanceMinor: bigint;
}

/** Credit FF gives (P-74): a promotion, which only adds, or a correction, either way. */
export interface CreditGrant {
  accountId: string;
  currency: string;
  /** Minor units, signed: what the wallet moves by. */
  amountMinor: bigint;
  kind: LedgerTransactionKind.PROMO | LedgerTransactionKind.ADJUSTMENT;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

interface StoredEntry {
  account_id: string | null;
  type: LedgerAccountType;
  currency: string;
  amount: string;
}

/**
 * The ledger (P-31, D9, parent §8.3): every movement of money is a posting,
 * one ledger transaction whose entries sum to zero, written once. A posting
 * is idempotent by its key; postings on a wallet go one after the other.
 * A customer account's balance is the sum of its wallet's entries.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Writes a posting in a database transaction of its own, and answers with
   * it. Its key's replay, with the same kind, currency and entries, writes
   * nothing and answers with the first (`created: false`): when and the
   * metadata stay the first's. The key with other entries is refused (409).
   */
  post(posting: Posting, options: PostOptions = {}): Promise<Posted> {
    return this.dataSource.transaction((manager) => this.postIn(manager, posting, options));
  }

  /**
   * The same, in the caller's database transaction (READ COMMITTED, the
   * default), for a posting that goes with other writes: a payment confirmed
   * (P-34), an invoice issued (P-36). The database checks the entries when
   * that transaction commits.
   */
  async postIn(manager: EntityManager, posting: Posting, options: PostOptions = {}): Promise<Posted> {
    checkPosting(posting);
    // Accounts are created in one order, as the wallets are locked below: two postings that create the same ones never wait for each other in a circle.
    const ids = new Map<string, string>();
    const accounts = posting.entries.map(({ account }) => account).sort((a, b) => refKey(a).localeCompare(refKey(b)));
    for (const account of accounts) ids.set(refKey(account), await this.ledgerAccountId(manager, account, posting.currency));
    // The posting's wallets, locked in one order: postings on a wallet go one after the other, and
    // the key and the balance below are read after any posting before it. FF's own accounts aren't
    // locked, so postings on different wallets never wait for each other.
    const wallets = posting.entries.filter(({ account }) => 'wallet' in account).map(({ account }) => ids.get(refKey(account)) as string);
    if (wallets.length > 0) await manager.query('SELECT "id" FROM "ledger_accounts" WHERE "id" = ANY($1::uuid[]) ORDER BY "id" FOR UPDATE', [wallets]);

    const replay = await this.replay(manager, posting);
    if (replay) return replay;
    if (options.floorMinor !== undefined) await this.checkFloor(manager, posting, options.floorMinor);

    const [row] = await manager.query<Array<{ id: string }>>(
      `INSERT INTO "ledger_transactions" ("kind", "idempotency_key", "occurred_at", "metadata") VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4)
       ON CONFLICT ("idempotency_key") DO NOTHING RETURNING "id"`,
      [posting.kind, posting.idempotencyKey, posting.occurredAt ?? null, posting.metadata ? JSON.stringify(posting.metadata) : null],
    );
    if (!row) {
      // The same key, posted at the same moment with no wallet in common, committed first.
      const first = await this.replay(manager, posting);
      if (!first) throw new Error(`Ledger key ${posting.idempotencyKey}: taken, yet no transaction has it`);
      return first;
    }
    const values = posting.entries.map((_, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3})`).join(', ');
    await manager.query(`INSERT INTO "ledger_entries" ("transaction_id", "ledger_account_id", "amount_minor") VALUES ${values}`, [
      row.id,
      ...posting.entries.flatMap(({ account, amountMinor }) => [ids.get(refKey(account)), amountMinor.toString()]),
    ]);
    return { created: true, transaction: await manager.findOneByOrFail(LedgerTransaction, { id: row.id }), entries: posting.entries };
  }

  /** A credit grant (P-74): the wallet moves by the amount, and FF's promotional credit, what the credit costs FF, by the opposite. */
  grantCredit(grant: CreditGrant, options: PostOptions = {}): Promise<Posted> {
    return this.dataSource.transaction((manager) => this.grantCreditIn(manager, grant, options));
  }

  /** The same, in the caller's database transaction: a grant written with its audit entry (P-74). */
  async grantCreditIn(manager: EntityManager, grant: CreditGrant, options: PostOptions = {}): Promise<Posted> {
    if (grant.kind === LedgerTransactionKind.PROMO && grant.amountMinor <= 0n) throw new Error('A promotion adds credit: its amount is above 0');
    return this.postIn(
      manager,
      {
        kind: grant.kind,
        idempotencyKey: grant.idempotencyKey,
        currency: grant.currency,
        metadata: grant.metadata,
        entries: [
          { account: { wallet: grant.accountId }, amountMinor: grant.amountMinor },
          { account: { ff: LedgerAccountType.PROMOTIONAL_CREDIT }, amountMinor: -grant.amountMinor },
        ],
      },
      options,
    );
  }

  /** A customer account's balance in a currency, in minor units: 0n before its wallet's first entry. */
  async balance(accountId: string, currency: string, manager: EntityManager = this.dataSource.manager): Promise<bigint> {
    const [row] = await manager.query<Array<{ balance: string }>>(
      `SELECT COALESCE(sum(e."amount_minor"), 0)::text AS "balance"
         FROM "ledger_entries" e JOIN "ledger_accounts" a ON a."id" = e."ledger_account_id"
        WHERE a."account_id" = $1 AND a."type" = 'wallet' AND a."currency" = $2`,
      [accountId, currency],
    );
    return BigInt(row.balance);
  }

  /** Each wallet a customer account has, with its balance, by currency: none before its first entry. */
  async balances(accountId: string): Promise<WalletBalance[]> {
    const rows = await this.dataSource.query<Array<{ currency: string; exponent: number; balance: string }>>(
      `SELECT a."currency", c."exponent", COALESCE(sum(e."amount_minor"), 0)::text AS "balance"
         FROM "ledger_accounts" a
         JOIN "currencies" c ON c."code" = a."currency"
         LEFT JOIN "ledger_entries" e ON e."ledger_account_id" = a."id"
        WHERE a."account_id" = $1 AND a."type" = 'wallet'
        GROUP BY a."currency", c."exponent" ORDER BY a."currency"`,
      [accountId],
    );
    return rows.map((row) => ({ currency: row.currency, exponent: row.exponent, balanceMinor: BigInt(row.balance) }));
  }

  /** A ledger account's ID, the account created with its first entry. */
  private async ledgerAccountId(manager: EntityManager, ref: LedgerAccountRef, currency: string): Promise<string> {
    const [find, insert, parameters] =
      'wallet' in ref
        ? [
            `SELECT "id" FROM "ledger_accounts" WHERE "account_id" = $1 AND "type" = 'wallet' AND "currency" = $2`,
            `INSERT INTO "ledger_accounts" ("account_id", "type", "currency") VALUES ($1, 'wallet', $2)
             ON CONFLICT ("account_id", "type", "currency") WHERE "account_id" IS NOT NULL DO NOTHING`,
            [ref.wallet, currency],
          ]
        : [
            `SELECT "id" FROM "ledger_accounts" WHERE "account_id" IS NULL AND "type" = $1 AND "currency" = $2`,
            `INSERT INTO "ledger_accounts" ("type", "currency") VALUES ($1, $2) ON CONFLICT ("type", "currency") WHERE "account_id" IS NULL DO NOTHING`,
            [ref.ff, currency],
          ];
    const [existing] = await manager.query<Array<{ id: string }>>(find, parameters);
    if (existing) return existing.id;
    // Created by another posting at the same moment, this waits for it, and then reads its row.
    await manager.query(insert, parameters);
    const [created] = await manager.query<Array<{ id: string }>>(find, parameters);
    return created.id;
  }

  /** The key's first posting, when it has one and this is its replay; refused when the entries differ. */
  private async replay(manager: EntityManager, posting: Posting): Promise<Posted | null> {
    const transaction = await manager.findOneBy(LedgerTransaction, { idempotencyKey: posting.idempotencyKey });
    if (!transaction) return null;
    const stored = await manager.query<StoredEntry[]>(
      `SELECT a."account_id", a."type", a."currency", e."amount_minor"::text AS "amount"
         FROM "ledger_entries" e JOIN "ledger_accounts" a ON a."id" = e."ledger_account_id"
        WHERE e."transaction_id" = $1 ORDER BY e."id"`,
      [transaction.id],
    );
    const entries: PostingEntry[] = stored.map((entry) => ({
      account: entry.account_id === null ? { ff: entry.type as FfAccountType } : { wallet: entry.account_id },
      amountMinor: BigInt(entry.amount),
    }));
    const same = transaction.kind === posting.kind && stored.every((entry) => entry.currency === posting.currency) && sameEntries(entries, posting.entries);
    if (!same) {
      throw new IdempotencyKeyConflictException(
        `The ledger key ${posting.idempotencyKey} was posted before, with other entries, as transaction ${transaction.id}: nothing was written`,
      );
    }
    return { created: false, transaction, entries };
  }

  /** Refuses a posting that would take a wallet it lowers below the floor. The wallets are locked: no posting comes between. */
  private async checkFloor(manager: EntityManager, posting: Posting, floorMinor: bigint): Promise<void> {
    for (const { account, amountMinor } of posting.entries) {
      if (!('wallet' in account) || amountMinor > 0n) continue;
      const balanceMinor = await this.balance(account.wallet, posting.currency, manager);
      if (balanceMinor + amountMinor >= floorMinor) continue;
      const [{ exponent }] = await manager.query<Array<{ exponent: number }>>('SELECT "exponent" FROM "currencies" WHERE "code" = $1', [posting.currency]);
      const amount = (minor: bigint) => `${formatMinor(minor, exponent)} ${posting.currency}`;
      throw new BalanceFloorException(
        account.wallet,
        balanceMinor,
        floorMinor,
        `Account ${account.wallet} has ${amount(balanceMinor)}: taking ${amount(-amountMinor)} would leave it below ${amount(floorMinor)}. Nothing was written`,
      );
    }
  }
}

/** Refuses a wrong posting before it takes any lock: a mistake in FF's code, named. */
function checkPosting(posting: Posting): void {
  const problem = postingProblem(posting);
  if (problem) throw new Error(`Ledger posting ${posting.idempotencyKey || '(no key)'}: ${problem}`);
}

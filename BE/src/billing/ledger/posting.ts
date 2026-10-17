import { LedgerAccountType } from './ledger-account.entity';
import { LedgerTransactionKind } from './ledger-transaction.entity';

/** FF's own accounts: every type but the wallet, which is a customer account's. */
export type FfAccountType = Exclude<LedgerAccountType, LedgerAccountType.WALLET>;

/** Where an entry goes, in the posting's currency: a customer account's wallet, or one of FF's own accounts. */
export type LedgerAccountRef = { wallet: string } | { ff: FfAccountType };

export interface PostingEntry {
  account: LedgerAccountRef;
  /** Minor units, signed, added to the account's balance; never 0. */
  amountMinor: bigint;
}

/**
 * One movement of money, as LedgerService.post() writes it (P-31): two
 * entries at least, each account once, summing to zero. A credit to a wallet
 * is positive. FF's own accounts follow the same rule: revenue, VAT payable
 * and stamp duty grow positive (earned, or owed to the state); the
 * provider's clearing and promotional credit grow negative (money a provider
 * holds for FF, credit FF paid for).
 */
export interface Posting {
  kind: LedgerTransactionKind;
  /** Makes a retry a no-op: usage:<account>:<hour>, konnect:<payment>, and so on. */
  idempotencyKey: string;
  currency: string;
  /** When what it records happened, such as the hour of usage; now by default. */
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
  entries: PostingEntry[];
}

/** An entry's account, as one string: "wallet:000000000001", "ff:revenue". */
export const refKey = (ref: LedgerAccountRef): string => ('wallet' in ref ? `wallet:${ref.wallet}` : `ff:${ref.ff}`);

const ACCOUNT_ID = /^\d{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const FF_TYPES = new Set<string>(Object.values(LedgerAccountType).filter((type) => type !== LedgerAccountType.WALLET));

/**
 * What is wrong with a posting, before it reaches the database, or null.
 * The database checks the sum again when the transaction commits; this
 * names the problem, and keeps a wrong posting from taking any lock.
 */
export function postingProblem(posting: Posting): string | null {
  if (!posting.idempotencyKey.trim()) return 'it has no idempotency key';
  if (!CURRENCY.test(posting.currency)) return `"${posting.currency}" is not a currency code`;
  if (posting.entries.length < 2) return 'it needs two entries at least';
  const seen = new Set<string>();
  let sum = 0n;
  for (const { account, amountMinor } of posting.entries) {
    const key = refKey(account);
    if ('wallet' in account ? !ACCOUNT_ID.test(account.wallet) : !FF_TYPES.has(account.ff)) return `${key} is not a ledger account`;
    if (seen.has(key)) return `${key} has two entries`;
    seen.add(key);
    if (typeof amountMinor !== 'bigint') return `${key}'s amount is not a bigint`;
    if (amountMinor === 0n) return `${key}'s amount is 0`;
    sum += amountMinor;
  }
  return sum === 0n ? null : `its entries sum to ${sum}, not 0`;
}

const canonical = (entries: PostingEntry[]) =>
  entries
    .map((entry) => `${refKey(entry.account)}=${entry.amountMinor}`)
    .sort()
    .join(' ');

/** Whether two postings' entries are the same, in any order: a key's replay must have the first posting's. */
export const sameEntries = (a: PostingEntry[], b: PostingEntry[]): boolean => canonical(a) === canonical(b);

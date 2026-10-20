/**
 * L1: what makes a ledger posting (client-readiness plan, P-31, D9): two
 * entries at least, each account once, none zero, summing to zero; and when
 * a replay of a key has the same entries. The database checks the sum again
 * at commit (ledger.db.spec.ts).
 */
import { LedgerAccountType } from './ledger-account.entity';
import { LedgerTransactionKind } from './ledger-transaction.entity';
import { FfAccountType, Posting, PostingEntry, postingProblem, sameEntries } from './posting';

const WALLET = '000000000001';
const wallet = (amountMinor: bigint): PostingEntry => ({ account: { wallet: WALLET }, amountMinor });
const ff = (type: FfAccountType, amountMinor: bigint): PostingEntry => ({ account: { ff: type }, amountMinor });
const posting = (entries: PostingEntry[], fields: Partial<Posting> = {}): Posting => ({
  kind: LedgerTransactionKind.TOPUP,
  idempotencyKey: 'konnect:pay-1',
  currency: 'TND',
  entries,
  ...fields,
});

describe('ledger postings (L1, P-31)', () => {
  it('takes a top-up as D9 books it: the credit to the wallet, the 19% VAT owed, the total at the provider', () => {
    expect(
      postingProblem(posting([wallet(50000n), ff(LedgerAccountType.VAT_PAYABLE, 9500n), ff(LedgerAccountType.PROVIDER_CLEARING, -59500n)])),
    ).toBeNull();
  });

  it('takes a usage debit and a promotion', () => {
    expect(postingProblem(posting([wallet(-8222n), ff(LedgerAccountType.REVENUE, 8222n)], { kind: LedgerTransactionKind.USAGE }))).toBeNull();
    expect(postingProblem(posting([wallet(10000n), ff(LedgerAccountType.PROMOTIONAL_CREDIT, -10000n)], { kind: LedgerTransactionKind.PROMO }))).toBeNull();
  });

  it('refuses entries that do not sum to zero, naming what is left over', () => {
    expect(postingProblem(posting([wallet(50000n), ff(LedgerAccountType.PROVIDER_CLEARING, -49999n)]))).toBe('its entries sum to 1, not 0');
    expect(postingProblem(posting([wallet(-1n), ff(LedgerAccountType.REVENUE, 2n)]))).toBe('its entries sum to 1, not 0');
  });

  it('refuses a posting of fewer than two entries, an entry of 0, and an account twice', () => {
    expect(postingProblem(posting([]))).toBe('it needs two entries at least');
    expect(postingProblem(posting([wallet(0n)]))).toBe('it needs two entries at least');
    expect(postingProblem(posting([wallet(0n), ff(LedgerAccountType.REVENUE, 0n)]))).toBe("wallet:000000000001's amount is 0");
    expect(postingProblem(posting([wallet(5n), wallet(-5n)]))).toBe('wallet:000000000001 has two entries');
    expect(postingProblem(posting([wallet(5n), ff(LedgerAccountType.REVENUE, -2n), ff(LedgerAccountType.REVENUE, -3n)]))).toBe('ff:revenue has two entries');
  });

  it('refuses an amount that is not a bigint, as a number would lose millimes past 2^53', () => {
    const asNumber = { account: { wallet: WALLET }, amountMinor: 5 as unknown as bigint };
    expect(postingProblem(posting([asNumber, ff(LedgerAccountType.REVENUE, -5n)]))).toBe("wallet:000000000001's amount is not a bigint");
  });

  it('refuses an account that is not one: a wallet without a 12-digit account ID, a wallet among FF\'s own, a type that does not exist', () => {
    expect(postingProblem(posting([{ account: { wallet: '1' }, amountMinor: 5n }, ff(LedgerAccountType.REVENUE, -5n)]))).toBe('wallet:1 is not a ledger account');
    expect(postingProblem(posting([wallet(5n), ff('wallet' as FfAccountType, -5n)]))).toBe('ff:wallet is not a ledger account');
    expect(postingProblem(posting([wallet(5n), ff('bank' as FfAccountType, -5n)]))).toBe('ff:bank is not a ledger account');
  });

  it('refuses a posting without a key or with a currency that is no code', () => {
    const entries = [wallet(5n), ff(LedgerAccountType.REVENUE, -5n)];
    expect(postingProblem(posting(entries, { idempotencyKey: ' ' }))).toBe('it has no idempotency key');
    expect(postingProblem(posting(entries, { currency: 'tnd' }))).toBe('"tnd" is not a currency code');
  });

  it('knows a replay: the same accounts and amounts, in any order, and nothing else', () => {
    const first = [wallet(-8222n), ff(LedgerAccountType.REVENUE, 8222n)];
    expect(sameEntries(first, [ff(LedgerAccountType.REVENUE, 8222n), wallet(-8222n)])).toBe(true);
    expect(sameEntries(first, [wallet(-8223n), ff(LedgerAccountType.REVENUE, 8223n)])).toBe(false);
    expect(sameEntries(first, [{ account: { wallet: '000000000002' }, amountMinor: -8222n }, ff(LedgerAccountType.REVENUE, 8222n)])).toBe(false);
    expect(sameEntries(first, [wallet(-8222n), ff(LedgerAccountType.PROMOTIONAL_CREDIT, 8222n)])).toBe(false);
    expect(sameEntries(first, [...first, ff(LedgerAccountType.STAMP_DUTY, 0n)])).toBe(false);
  });
});

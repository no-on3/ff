/**
 * L1: the billing reconciliation's verdict and table (client-readiness plan,
 * P-32, parent B-01). reconcile() runs against PostgreSQL in
 * hourly-rating.db.spec.ts.
 */
import { ReconciledAccount, formatReconciliation, reconciled } from './reconciliation';

const account = (fields: Partial<ReconciledAccount>): ReconciledAccount => ({
  accountId: '000000000001',
  currency: 'TND',
  exponent: 3,
  chargedMinor: 1234n,
  estimatedMinor: 1234n,
  ratedRequests: 1500n,
  rawRequests: 1500n,
  ratedByteHours: 0n,
  sampledByteHours: 0n,
  ...fields,
});

describe('the billing reconciliation (L1, P-32)', () => {
  it("agrees only when the charges, the requests and the databases' storage all match", () => {
    expect(reconciled(account({}))).toBe(true);
    expect(reconciled(account({ estimatedMinor: 1235n }))).toBe(false);
    expect(reconciled(account({ rawRequests: 1501n }))).toBe(false);
    expect(reconciled(account({ ratedByteHours: 7_634_423n, sampledByteHours: 7_634_423n }))).toBe(true);
    expect(reconciled(account({ ratedByteHours: 7_634_423n, sampledByteHours: 15_268_846n }))).toBe(false);
  });

  it('writes one line per account, money to the millime, and marks each that differs', () => {
    const table = formatReconciliation({
      month: '2026-10',
      ratedUntil: new Date('2026-10-17T10:00:00Z'),
      accounts: [
        account({ ratedByteHours: 1_500n * 1_073_741_824n, sampledByteHours: 1_500n * 1_073_741_824n }),
        account({ accountId: '000000000002', chargedMinor: 0n, estimatedMinor: 8222n, ratedRequests: 0n, rawRequests: 3n, sampledByteHours: 536_870_912n }),
      ],
    });

    expect(table.split('\n')).toEqual([
      '2026-10 until 2026-10-17T10:00:00.000Z (the end of the last hour rated):',
      '',
      'Account         Charged  From usage  Requests rated  Requests used  GB-h rated  GB-h sampled',
      '000000000001  1.234 TND   1.234 TND           1,500          1,500   1,500.000     1,500.000  ok',
      '000000000002  0.000 TND   8.222 TND               0              3       0.000         0.500  DIFFERENT',
      '',
      '1 of 2 accounts differs.',
    ]);
  });

  it('says how many agree, in words that fit', () => {
    const last = (accounts: ReconciledAccount[]) => formatReconciliation({ month: '2026-10', ratedUntil: new Date('2026-10-17T10:00:00Z'), accounts }).split('\n').at(-1);

    expect(last([account({})])).toBe('The account agrees.');
    expect(last([account({}), account({ accountId: '000000000002' })])).toBe('All 2 accounts agree.');
    expect(last([account({ estimatedMinor: 0n })])).toBe('The account differs.');
    expect(last([account({ estimatedMinor: 0n }), account({ accountId: '000000000002', rawRequests: 0n })])).toBe('2 of 2 accounts differ.');
  });

  it('says when no hour of the month is rated, or nobody used anything', () => {
    expect(formatReconciliation({ month: '2026-09', ratedUntil: null, accounts: [] })).toBe('No hour of 2026-09 is rated yet.');
    expect(formatReconciliation({ month: '2026-10', ratedUntil: new Date('2026-10-01T05:00:00Z'), accounts: [] }).split('\n').at(-1)).toBe('No account used anything.');
  });
});

/**
 * L1: a month's usage statement (client-readiness plan, P-36, D9), priced as
 * the hourly rating prices the month: each function's usage and cost, the
 * free tier, the total rounded once, and what the rating debited or only
 * rated in shadow mode.
 */
import { Decimal } from '../decimal';
import { BookPrices } from '../price-book';
import { buildStatement, StatementInput } from './statement';

const book = (id: string, validFrom: string, perMillion: string): BookPrices => ({
  id,
  validFrom: new Date(validFrom),
  freeRequests: Decimal.of(1_000_000),
  freeGbSeconds: Decimal.of(400_000),
  perRequest: Decimal.parse(perMillion).times(Decimal.ratio(1n, 1_000_000n)),
  gbSecondTiers: [{ upTo: null, price: Decimal.parse('0.0000501334336') }],
  provisionedGbSecond: Decimal.parse('0.0000125334336'),
  provisionedDurationGbSecond: Decimal.parse('0.0000292443776'),
  minimumBilledMs: 0,
  idleInstanceGbSecond: Decimal.ZERO,
  monthlyPlanFee: Decimal.ZERO,
});
const usage = (functionId: string, priceBookId: string, requests: bigint, mbMs: bigint) => ({
  functionId,
  priceBookId,
  onDemand: { requests, mbMs },
  provisioned: { requests: 0n, mbMs: 0n },
  provisionedMbMs: 0n,
  reservedMbMs: 0n,
});
const OCTOBER: StatementInput = {
  month: '2026-10',
  currency: 'TND',
  exponent: 3,
  books: [book('b1', '2026-10-01T00:00:00Z', '0.6016')],
  rows: [usage('f-2', 'b1', 2_000_000n, 1_024_000_000_000n), usage('f-1', 'b1', 10n, 1_280n)],
  names: new Map([
    ['f-1', 'resize-images'],
    ['f-2', 'hello'],
  ]),
  charges: { debitedMinor: 20_655n, shadowMinor: 0n, ratedUntil: new Date('2026-11-01T00:00:00Z') },
  monthEnd: new Date('2026-11-01T00:00:00Z'),
};

describe("a month's usage statement (L1, P-36)", () => {
  it('lists each function by name: its requests, GB-seconds and cost before the free tier', () => {
    const statement = buildStatement(OCTOBER);

    expect(statement.functions).toEqual([
      // 2,000,000 requests at 0.6016 per million, and 1,000,000 GB-s at 0.0000501334336: 1.2032 + 50.1334336
      { functionId: 'f-2', name: 'hello', requests: 2_000_000n, gbSeconds: '1000000', amountMinor: 51_337n },
      { functionId: 'f-1', name: 'resize-images', requests: 10n, gbSeconds: '0.00125', amountMinor: 0n },
    ]);
  });

  it('takes the free tier off, and rounds the total once, as the hourly rating charged it', () => {
    const statement = buildStatement(OCTOBER);

    // The free tier: 1,000,000 requests (0.6016) and 400,000 GB-s (20.05337344).
    expect([statement.usageMinor, statement.freeTierMinor, statement.volumeTiersMinor, statement.monthlyFeeMinor, statement.totalMinor]).toEqual([
      51_337n,
      -20_655n,
      0n,
      0n,
      30_682n,
    ]);
    expect([statement.debitedMinor, statement.shadowMinor, statement.complete]).toEqual([20_655n, 0n, true]);
  });

  it('adds up a function priced by two books, each its own hours', () => {
    const statement = buildStatement({
      ...OCTOBER,
      books: [book('b1', '2026-10-01T00:00:00Z', '0.6016'), book('b2', '2026-10-15T00:00:00Z', '1.2032')],
      rows: [usage('f-1', 'b1', 600_000n, 0n), usage('f-1', 'b2', 600_000n, 0n)],
    });

    // 1,200,000 requests: the first million free, wherever it falls; the last 200,000 at the second book's price.
    expect(statement.functions).toEqual([{ functionId: 'f-1', name: 'resize-images', requests: 1_200_000n, gbSeconds: '0', amountMinor: 1_083n }]);
    expect([statement.freeTierMinor, statement.totalMinor]).toEqual([-842n, 241n]);
  });

  it("says what shadow mode only rated, and that a month isn't rated to its end", () => {
    const statement = buildStatement({ ...OCTOBER, charges: { debitedMinor: 120n, shadowMinor: 20_535n, ratedUntil: new Date('2026-10-20T15:00:00Z') } });

    expect([statement.debitedMinor, statement.shadowMinor, statement.complete]).toEqual([120n, 20_535n, false]);
    expect(buildStatement({ ...OCTOBER, charges: { ...OCTOBER.charges, ratedUntil: null } }).complete).toBe(false);
  });

  it("names a function by its ID when its name is gone, and lists nothing for a month without usage", () => {
    expect(buildStatement({ ...OCTOBER, names: new Map() }).functions.map((fn) => fn.name)).toEqual(['f-1', 'f-2']);
    const empty = buildStatement({ ...OCTOBER, rows: [] });
    expect([empty.functions, empty.usageMinor, empty.totalMinor]).toEqual([[], 0n, 0n]);
  });
});

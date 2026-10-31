/**
 * L1: a month's usage statement (client-readiness plan, P-36, D9), priced as
 * the hourly rating prices the month: each function's usage and cost, each
 * database's, queue's and cache's, each domain's mail, the free tier, the total rounded once, and
 * what the rating debited or only rated in shadow mode.
 */
import { Decimal } from '../decimal';
import { BookPrices, NO_RESOURCE_PRICES } from '../price-book';
import { buildStatement, StatementInput } from './statement';

const GIB = 1_073_741_824n;
/** A database of `gb` GB through `hours` of the month's hours, with one book. */
const database = (resourceId: string, name: string, priceBookId: string, gb: bigint, hours: bigint) => ({
  resourceId,
  kind: 'database' as const,
  name,
  priceBookId,
  byteHours: gb * GIB * hours,
  hours,
  tier1Requests: 0n,
  tier2Requests: 0n,
  requests: 0n,
  bytes: 0n,
});
/** A queue asked `requests` requests in the month, as SQS bills them. */
const queue = (resourceId: string, name: string, priceBookId: string, requests: bigint) => ({
  resourceId,
  kind: 'queue' as const,
  name,
  priceBookId,
  byteHours: 0n,
  hours: 0n,
  tier1Requests: 0n,
  tier2Requests: 0n,
  requests,
  bytes: 0n,
});
/** A domain's mail in the month: its recipients, and its attachments' bytes, each recipient's copy. */
const mail = (resourceId: string, name: string, priceBookId: string, recipients: bigint, bytes: bigint) => ({
  resourceId,
  kind: 'email' as const,
  name,
  priceBookId,
  byteHours: 0n,
  hours: 0n,
  tier1Requests: 0n,
  tier2Requests: 0n,
  requests: recipients,
  bytes,
});
/** A cache of `mb` MB through `hours` of the month's hours, its memory the plan's. */
const cache = (resourceId: string, name: string, priceBookId: string, mb: bigint, hours: bigint) => ({
  resourceId,
  kind: 'cache' as const,
  name,
  priceBookId,
  byteHours: mb * 1_048_576n * hours,
  hours,
  tier1Requests: 0n,
  tier2Requests: 0n,
  requests: 0n,
  bytes: 0n,
});

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
  ...NO_RESOURCE_PRICES,
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
  resources: [],
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

  it("lists each database by name, its GB-months and cost before the free tier, and takes its free GB-month off", () => {
    // RDS's gp3 at 0.115 US$ times 3.0080 per GB-month, and 1 GB-month free in the month.
    const priced = { ...book('b1', '2026-10-01T00:00:00Z', '0.6016'), databaseStorageGbMonth: Decimal.parse('0.34592'), freeDatabaseGbMonths: Decimal.of(1) };

    const statement = buildStatement({
      ...OCTOBER,
      books: [priced],
      rows: [],
      resources: [database('d-2', 'orders', 'b1', 10n, 744n), database('d-1', 'audit', 'b1', 2n, 100n)],
    });

    expect(statement.resources).toEqual([
      // 2 GB for 100 of October's 744 hours: 0.268817 GB-month, 0.092989 TND; 10 GB all month: 3.4592 TND.
      { resourceId: 'd-1', kind: 'database', name: 'audit', gbMonths: '0.268817', hours: 100n, gbHours: '200', tier1Requests: 0n, tier2Requests: 0n, requests: 0n, attachmentsGb: '0', amountMinor: 93n },
      { resourceId: 'd-2', kind: 'database', name: 'orders', gbMonths: '10', hours: 744n, gbHours: '7440', tier1Requests: 0n, tier2Requests: 0n, requests: 0n, attachmentsGb: '0', amountMinor: 3_459n },
    ]);
    expect([statement.functions, statement.usageMinor, statement.freeTierMinor, statement.totalMinor]).toEqual([[], 3_552n, -346n, 3_206n]);
  });

  it('lists each queue by name, its requests and cost before the free tier, and takes the free million off', () => {
    // SQS's $0.40 a million times 3.0080, and 1,000,000 requests free in the month.
    const priced = { ...book('b1', '2026-10-01T00:00:00Z', '0.6016'), queueRequestTiers: [{ upTo: null, price: Decimal.parse('0.0000012032') }], freeQueueRequests: Decimal.of(1_000_000) };

    const statement = buildStatement({ ...OCTOBER, books: [priced], rows: [], resources: [queue('q-2', 'receipts', 'b1', 500_000n), queue('q-1', 'orders', 'b1', 3_000_000n)] });

    expect(statement.resources).toEqual([
      // 3,000,000 requests: 3.6096 TND; 500,000: 0.6016 TND.
      { resourceId: 'q-1', kind: 'queue', name: 'orders', gbMonths: '0', hours: 0n, gbHours: '0', tier1Requests: 0n, tier2Requests: 0n, requests: 3_000_000n, attachmentsGb: '0', amountMinor: 3_610n },
      { resourceId: 'q-2', kind: 'queue', name: 'receipts', gbMonths: '0', hours: 0n, gbHours: '0', tier1Requests: 0n, tier2Requests: 0n, requests: 500_000n, attachmentsGb: '0', amountMinor: 602n },
    ]);
    expect([statement.usageMinor, statement.freeTierMinor, statement.totalMinor]).toEqual([4_211n, -1_203n, 3_008n]);
  });

  it('lists each cache by name, its hours, GB-hours and cost, as ElastiCache bills a node, with no free tier', () => {
    // ElastiCache for Valkey's $0.0256 a GB-hour times 3.0080.
    const priced = { ...book('b1', '2026-10-01T00:00:00Z', '0.6016'), cacheGbHour: Decimal.parse('0.0770048') };

    const statement = buildStatement({ ...OCTOBER, books: [priced], rows: [], resources: [cache('c-1', 'sessions', 'b1', 64n, 744n)] });

    expect(statement.resources).toEqual([
      // 64 MB through October's 744 hours: 46.5 GB-hours, 3.5807232 TND.
      { resourceId: 'c-1', kind: 'cache', name: 'sessions', gbMonths: '0.0625', hours: 744n, gbHours: '46.5', tier1Requests: 0n, tier2Requests: 0n, requests: 0n, attachmentsGb: '0', amountMinor: 3_581n },
    ]);
    expect([statement.usageMinor, statement.freeTierMinor, statement.totalMinor]).toEqual([3_581n, 0n, 3_581n]);
  });

  it("lists each domain's or address's mail by name, its recipients, its attachments' GB and cost, as SES bills them, with no free tier", () => {
    // SES's $0.10 a thousand recipients and $0.12 a GB of attachments, times 3.0080.
    const priced = { ...book('b1', '2026-10-01T00:00:00Z', '0.6016'), perEmailRecipient: Decimal.parse('0.0003008'), emailAttachmentsGb: Decimal.parse('0.36096') };

    const statement = buildStatement({ ...OCTOBER, books: [priced], rows: [], resources: [mail('e-1', 'shop.example.tn', 'b1', 12_500n, 2n * GIB)] });

    expect(statement.resources).toEqual([
      // 12,500 recipients: 3.76 TND; 2 GB of attachments: 0.72192 TND.
      { resourceId: 'e-1', kind: 'email', name: 'shop.example.tn', gbMonths: '0', hours: 0n, gbHours: '0', tier1Requests: 0n, tier2Requests: 0n, requests: 12_500n, attachmentsGb: '2', amountMinor: 4_482n },
    ]);
    expect([statement.usageMinor, statement.freeTierMinor, statement.totalMinor]).toEqual([4_482n, 0n, 4_482n]);
  });

  it("names a function by its ID when its name is gone, and lists nothing for a month without usage", () => {
    expect(buildStatement({ ...OCTOBER, names: new Map() }).functions.map((fn) => fn.name)).toEqual(['f-1', 'f-2']);
    const empty = buildStatement({ ...OCTOBER, rows: [] });
    expect([empty.functions, empty.usageMinor, empty.totalMinor]).toEqual([[], 0n, 0n]);
  });
});

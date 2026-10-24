import { Repository } from 'typeorm';
import { AsyncEventCount } from './async-event-count.entity';
import { AsyncEventCounts } from './async-event-counts.service';

const FN = { functionId: 'fn-1', accountId: '000000000001' };

describe("functions' asynchronous calls, counted by the minute for Lambda's metrics", () => {
  let inserted: AsyncEventCount[][];
  let refuse: boolean;
  let counts: AsyncEventCounts;
  const at = (instant: string) => jest.setSystemTime(new Date(instant));

  beforeEach(() => {
    jest.useFakeTimers();
    inserted = [];
    refuse = false;
    counts = new AsyncEventCounts({
      insert: async (rows: AsyncEventCount[]) => {
        if (refuse) throw new Error('the database is away');
        inserted.push(rows);
      },
    } as unknown as Repository<AsyncEventCount>);
  });

  afterEach(() => jest.useRealTimers());

  it("adds a function's minute up: events received and dropped, records not delivered, and each attempt's age, their sum and the oldest", async () => {
    at('2026-10-24T06:00:01Z');
    counts.count({ ...FN, received: 1 });
    counts.count({ ...FN, received: 1 });
    counts.count({ ...FN, ageMs: 1_200 });
    at('2026-10-24T06:00:40Z');
    counts.count({ ...FN, ageMs: 61_000.4 });
    counts.count({ ...FN, dropped: 1 });
    counts.count({ ...FN, destinationFailures: 1 });
    counts.count({ functionId: 'fn-2', accountId: FN.accountId, received: 1 });
    at('2026-10-24T06:01:00Z');
    counts.count({ ...FN, received: 1 });

    expect(await counts.flush(new Date('2026-10-24T06:01:00Z'))).toBe(2);

    expect(inserted[0].map((row) => ({ ...row }))).toEqual([
      {
        functionId: 'fn-1',
        minute: new Date('2026-10-24T06:00:00Z'),
        accountId: FN.accountId,
        received: 2,
        dropped: 1,
        destinationFailures: 1,
        attempts: 2,
        ageMsSum: 62_200n,
        ageMsMax: 61_000,
        writer: counts.writer,
      },
      expect.objectContaining({ functionId: 'fn-2', received: 1, attempts: 0, ageMsSum: 0n, ageMsMax: 0 }),
    ]);
    // The minute under way waits for its end, or for the backend's.
    expect(await counts.flush()).toBe(1);
    expect(inserted[1][0]).toMatchObject({ minute: new Date('2026-10-24T06:01:00Z'), received: 1 });
  });

  it('keeps the minutes the database refused, added to those counted since, for the next turn', async () => {
    at('2026-10-24T06:00:01Z');
    counts.count({ ...FN, ageMs: 500 });
    refuse = true;

    expect(await counts.flush()).toBe(0);
    counts.count({ ...FN, ageMs: 900, received: 1 });
    refuse = false;
    expect(await counts.flush()).toBe(1);

    expect(inserted).toEqual([[expect.objectContaining({ received: 1, attempts: 2, ageMsSum: 1_400n, ageMsMax: 900 })]]);
  });
});

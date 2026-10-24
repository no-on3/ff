import { Repository } from 'typeorm';
import { QueueRequestCount } from './queue-request-count.entity';
import { QueueRequestCounts } from './queue-request-counts.service';
import { QueueUse, billedRequests } from './queue-tally';

const use = (extra: Partial<QueueUse> = {}): QueueUse => ({ queueId: 'q1', accountId: '000000000001', queueName: 'orders', requests: 1, ...extra });

describe("queues' requests, counted by the minute", () => {
  let inserted: QueueRequestCount[][];
  let refuse: boolean;
  let counts: QueueRequestCounts;
  const at = (instant: string) => jest.setSystemTime(new Date(instant));

  beforeEach(() => {
    jest.useFakeTimers();
    inserted = [];
    refuse = false;
    counts = new QueueRequestCounts({
      insert: async (rows: QueueRequestCount[]) => {
        if (refuse) throw new Error('the database is away');
        inserted.push(rows);
      },
    } as unknown as Repository<QueueRequestCount>);
  });

  afterEach(() => jest.useRealTimers());

  it.each([
    [0, 1],
    [1, 1],
    [65_536, 1],
    [65_537, 2],
    [262_144, 4],
    [1_048_576, 16],
  ])('bills a request carrying %d bytes of messages as %d, as SQS bills each 64 KB', (bytes, requests) => {
    expect(billedRequests(bytes)).toBe(requests);
  });

  it("adds a queue's minute up: its requests, the messages sent with their bytes and the largest, received, deleted, and the empty receives", async () => {
    at('2026-10-24T06:00:01Z');
    counts.count(use({ requests: 2, sentSizes: [70_000, 300] }));
    at('2026-10-24T06:00:20Z');
    counts.count(use({ received: 2 }));
    counts.count(use({ emptyReceives: 1 }));
    counts.count(use({ requests: 0, deleted: 2 }));
    counts.count(use({ queueId: 'q2', queueName: 'receipts', sentSizes: [12] }));
    at('2026-10-24T06:01:00Z');
    counts.count(use());

    expect(await counts.flush(new Date('2026-10-24T06:01:00Z'))).toBe(2);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].map((row) => ({ ...row }))).toEqual([
      {
        queueId: 'q1',
        minute: new Date('2026-10-24T06:00:00Z'),
        writer: counts.writer,
        accountId: '000000000001',
        name: 'orders',
        requests: 4,
        sent: 2,
        received: 2,
        deleted: 2,
        emptyReceives: 1,
        sentBytes: 70_300n,
        sentMaxBytes: 70_000,
      },
      expect.objectContaining({ queueId: 'q2', name: 'receipts', requests: 1, sent: 1, sentBytes: 12n, sentMaxBytes: 12 }),
    ]);
    // The minute under way waits for its end, or for the backend's.
    expect(await counts.flush()).toBe(1);
    expect(inserted[1][0]).toMatchObject({ minute: new Date('2026-10-24T06:01:00Z'), requests: 1 });
  });

  it('counts a long poll in the minute it was answered, so that a minute written takes nothing more', async () => {
    at('2026-10-24T06:00:50Z');
    counts.count(use());
    at('2026-10-24T06:01:05Z');
    expect(await counts.flush(new Date('2026-10-24T06:01:00Z'))).toBe(1);

    // A receive that began at 06:00:50 and waited 20 s.
    at('2026-10-24T06:01:10Z');
    counts.count(use({ emptyReceives: 1 }));
    expect(await counts.flush()).toBe(1);

    expect(inserted.map((rows) => rows[0].minute)).toEqual([new Date('2026-10-24T06:00:00Z'), new Date('2026-10-24T06:01:00Z')]);
  });

  it('keeps the minutes the database refused, added to those counted since, for the next turn', async () => {
    at('2026-10-24T06:00:01Z');
    counts.count(use({ sentSizes: [10] }));
    refuse = true;

    expect(await counts.flush()).toBe(0);
    counts.count(use({ sentSizes: [30] }));
    refuse = false;
    expect(await counts.flush()).toBe(1);

    expect(inserted).toEqual([[expect.objectContaining({ requests: 2, sent: 2, sentBytes: 40n, sentMaxBytes: 30 })]]);
  });
});

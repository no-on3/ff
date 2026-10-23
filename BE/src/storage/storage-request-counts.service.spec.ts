import { Repository } from 'typeorm';
import { CountedRequest } from './request-tally';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';

const request = (at: string, extra: Partial<CountedRequest> = {}): CountedRequest => ({
  bucketId: 'b1',
  accountId: '000000000001',
  bucketName: 'photos',
  class: 'tier1',
  method: 'PUT',
  status: 200,
  bytesIn: 100,
  bytesOut: 0,
  at: new Date(at),
  ...extra,
});

describe("buckets' requests, counted by the minute", () => {
  let inserted: StorageRequestCount[][];
  let refuse: boolean;
  let service: StorageRequestCountsService;

  beforeEach(() => {
    inserted = [];
    refuse = false;
    const repository = {
      insert: async (rows: StorageRequestCount[]) => {
        if (refuse) throw new Error('the database is away');
        inserted.push(rows);
      },
    } as unknown as Repository<StorageRequestCount>;
    service = new StorageRequestCountsService(repository);
  });

  it("adds a bucket's requests up by minute and class: GETs, PUTs, 4xx and 5xx, bytes both ways; one row each, named by this process", async () => {
    service.count(request('2026-10-23T06:00:01Z'));
    service.count(request('2026-10-23T06:00:59Z', { status: 403, bytesIn: 0 }));
    service.count(request('2026-10-23T06:00:30Z', { class: 'tier2', method: 'GET', status: 206, bytesIn: 0, bytesOut: 4 }));
    service.count(request('2026-10-23T06:00:31Z', { class: 'tier2', method: 'HEAD', status: 500, bytesIn: 0 }));
    service.count(request('2026-10-23T06:01:00Z'));

    expect(await service.flush(new Date('2026-10-23T06:01:00Z'))).toBe(2);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].map((row) => ({ ...row }))).toEqual([
      expect.objectContaining({ minute: new Date('2026-10-23T06:00:00Z'), class: 'tier1', writer: service.writer, name: 'photos', requests: 2, puts: 2, gets: 0, errors4xx: 1, errors5xx: 0, bytesIn: 100n, bytesOut: 0n }),
      expect.objectContaining({ minute: new Date('2026-10-23T06:00:00Z'), class: 'tier2', requests: 2, gets: 1, puts: 0, errors4xx: 0, errors5xx: 1, bytesOut: 4n }),
    ]);
    // The minute under way waits for its end, or for the backend's.
    expect(await service.flush()).toBe(1);
    expect(inserted[1][0]).toMatchObject({ minute: new Date('2026-10-23T06:01:00Z'), requests: 1 });
  });

  it('keeps the minutes the database refused, added to those counted since, for the next turn', async () => {
    service.count(request('2026-10-23T06:00:01Z'));
    refuse = true;

    expect(await service.flush()).toBe(0);
    service.count(request('2026-10-23T06:00:02Z', { bytesIn: 50 }));
    refuse = false;
    expect(await service.flush()).toBe(1);

    expect(inserted).toEqual([[expect.objectContaining({ requests: 2, puts: 2, bytesIn: 150n })]]);
  });
});

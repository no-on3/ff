import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { CapacityService, nextSampleDelay } from './capacity.service';

/** The sampler against stand-ins: its SQL runs against PostgreSQL in capacity.db.spec.ts (L2). */
describe('CapacityService (P-21)', () => {
  const F1 = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
  const F2 = 'a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b';
  let ready: jest.Mock<Promise<Map<string, number>>, []>;
  let query: jest.Mock;
  let service: CapacityService;
  let logged: jest.SpyInstance;

  beforeEach(() => {
    ready = jest.fn(async () => new Map([[F1, 2], [F2, 1]]));
    query = jest.fn(async (_sql: string, [ids]: [string[]]) => ids.map((id) => ({ function_id: id })));
    service = new CapacityService({ readyInstancesByFunction: ready } as unknown as Orchestrator, { query } as unknown as DataSource);
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each([
    ['10:00:03.000', 2_000], // this minute's sample is still to come
    ['10:00:05.000', 60_000],
    ['10:00:30.000', 35_000],
    ['10:00:59.999', 5_001],
  ])('takes the next sample 5 s into a minute: at %s, in %i ms', (time, delay) => {
    expect(nextSampleDelay(Date.parse(`2026-10-17T${time}Z`))).toBe(delay);
  });

  it('samples with one call to the orchestrator and one statement: every ready function, its instances, the minute', async () => {
    const at = new Date('2026-10-17T10:01:05Z');

    await expect(service.sample(at)).resolves.toBe(2);

    expect(ready).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "capacity_samples"');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(parameters).toEqual([[F1, F2], [2, 1], at]);
  });

  it("writes nothing when no function has a ready instance, and leaves out an ID that isn't one", async () => {
    ready.mockResolvedValueOnce(new Map());
    ready.mockResolvedValueOnce(new Map([['fn-; DROP TABLE functions', 1], [F1, 1]]));

    await expect(service.sample()).resolves.toBe(0);
    await expect(service.sample()).resolves.toBe(1);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([[F1], [1], null]); // null: the database's minute
  });

  it('samples 5 s into every minute, says when one fails, and samples the next minute all the same', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:30Z') });
    const sampled: string[] = [];
    ready.mockImplementation(async () => {
      sampled.push(new Date().toISOString().slice(11, 19));
      if (sampled.length === 2) throw new Error('the API server is unreachable');
      return new Map([[F1, 1]]);
    });

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(3 * 60_000);

    expect(sampled).toEqual(['10:01:05', '10:02:05', '10:03:05']);
    expect(logged).toHaveBeenCalledWith('Could not sample capacity: the API server is unreachable');
  });

  it('stops when the module stops, even during a sample', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:30Z') });
    let finish!: (value: Map<string, number>) => void;
    ready.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(35_000); // the first sample has started
    service.onModuleDestroy();
    finish(new Map([[F1, 1]]));
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(ready).toHaveBeenCalledTimes(1);
  });
});

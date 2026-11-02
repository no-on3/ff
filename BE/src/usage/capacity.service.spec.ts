import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Orchestrator, WorkloadInstances } from '../orchestrator/orchestrator.types';
import { CapacityService, nextSampleDelay } from './capacity.service';

/** The sampler against stand-ins: its SQL runs against PostgreSQL in capacity.db.spec.ts (L2). */
describe('CapacityService', () => {
  const F1 = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
  const F2 = 'a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b';
  let ready: jest.Mock<Promise<WorkloadInstances[]>, []>;
  let query: jest.Mock;
  let service: CapacityService;
  let logged: jest.SpyInstance;
  const workload = (functionId: string, instances: number, version?: number): WorkloadInstances => ({ functionId, version, desired: instances, ready: instances });

  beforeEach(() => {
    ready = jest.fn(async () => [workload(F1, 2), workload(F2, 1)]);
    query = jest.fn(async (_sql: string, [ids]: [string[]]) => ids.map((id) => ({ function_id: id })));
    service = new CapacityService({ workloads: ready } as unknown as Orchestrator, { query } as unknown as DataSource);
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

  it('samples with one call to the orchestrator and one statement: each ready Deployment, its version, its instances, the minute', async () => {
    const at = new Date('2026-10-17T10:01:05Z');
    ready.mockResolvedValueOnce([workload(F1, 2), workload(F1, 3, 4), workload(F2, 1)]);
    query.mockResolvedValueOnce([{ function_id: F1 }, { function_id: F1 }, { function_id: F2 }]);

    await expect(service.sample(at)).resolves.toBe(3);

    expect(ready).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "capacity_samples"');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    // $LATEST's as version 0, which no version is numbered.
    expect(parameters).toEqual([[F1, F1, F2], [0, 4, 0], [2, 3, 1], at]);
  });

  it("writes nothing when no Deployment has a ready instance, and leaves out one at zero or starting, and an ID that isn't one", async () => {
    ready.mockResolvedValueOnce([]);
    ready.mockResolvedValueOnce([{ ...workload(F2, 0), desired: 1 }, workload(F2, 0, 3)]);
    ready.mockResolvedValueOnce([workload('fn-; DROP TABLE functions', 1), workload(F1, 1)]);

    await expect(service.sample()).resolves.toBe(0);
    await expect(service.sample()).resolves.toBe(0);
    await expect(service.sample()).resolves.toBe(1);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([[F1], [0], [1], null]); // null: the database's minute
  });

  it('samples 5 s into every minute, says when one fails, and samples the next minute all the same', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:30Z') });
    const sampled: string[] = [];
    ready.mockImplementation(async () => {
      sampled.push(new Date().toISOString().slice(11, 19));
      if (sampled.length === 2) throw new Error('the API server is unreachable');
      return [workload(F1, 1)];
    });

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(3 * 60_000);

    expect(sampled).toEqual(['10:01:05', '10:02:05', '10:03:05']);
    expect(logged).toHaveBeenCalledWith('Could not sample capacity: the API server is unreachable');
  });

  it('stops when the module stops, even during a sample', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-17T10:00:30Z') });
    let finish!: (value: WorkloadInstances[]) => void;
    ready.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(35_000); // the first sample has started
    service.onModuleDestroy();
    finish([workload(F1, 1)]);
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(ready).toHaveBeenCalledTimes(1);
  });
});

import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { MAX_POINTS, MetricsWindow, metricsView, metricsWindow } from './customer-metrics';
import { MAX_HELD, RefusedInvocationsService } from './refused-invocations.service';

const NOW = new Date('2026-10-19T10:07:30Z');
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

describe('metricsWindow', () => {
  it('ends now and starts 60 periods before by default, in whole minutes of UTC time', () => {
    expect(metricsWindow({}, NOW)).toEqual({ start: new Date('2026-10-19T09:07:00Z'), end: new Date('2026-10-19T10:08:00Z'), period: 60 });
  });

  it('rounds the start down and the end up to whole periods of five minutes or an hour', () => {
    expect(metricsWindow({ start: '2026-10-19T09:02:00Z', end: '2026-10-19T09:58:00Z', period: 300 }, NOW)).toEqual({
      start: new Date('2026-10-19T09:00:00Z'),
      end: new Date('2026-10-19T10:00:00Z'),
      period: 300,
    });
    expect(metricsWindow({ start: '2026-10-19T10:00:00+01:00', end: '2026-10-19T09:30:00Z', period: 3600 }, NOW)).toEqual({
      start: new Date('2026-10-19T09:00:00Z'),
      end: new Date('2026-10-19T10:00:00Z'),
      period: 3600,
    });
  });

  it('refuses a start not before the end, and more points than an answer gives', () => {
    expect(metricsWindow({ start: '2026-10-19T10:00:00Z', end: '2026-10-19T10:00:00Z' }, NOW)).toEqual({ problem: 'start must be before end' });
    expect(metricsWindow({ start: '2026-10-18T09:00:00Z', end: '2026-10-19T09:00:00Z' }, NOW)).toEqual({ start: new Date('2026-10-18T09:00:00Z'), end: new Date('2026-10-19T09:00:00Z'), period: 60 });
    expect(metricsWindow({ start: '2026-10-18T09:00:00Z', end: '2026-10-19T09:01:00Z' }, NOW)).toEqual({
      problem: `The window holds ${MAX_POINTS + 1} periods of 60 s: at most ${MAX_POINTS}. Take a longer period, or a shorter window`,
    });
  });
});

describe('metricsView', () => {
  const window: MetricsWindow = { start: new Date('2026-10-19T09:00:00Z'), end: new Date('2026-10-19T09:15:00Z'), period: 300 };
  const at = (iso: string) => new Date(iso).getTime() / 1000;

  it('gives a point per period, oldest first: quiet periods at zero, no duration where none was measured, and the instances', () => {
    const view = metricsView(
      window,
      [
        {
          bucket: at('2026-10-19T09:05:00Z'),
          invocations: 4,
          errors: 1,
          throttles: 2,
          coldStarts: 1,
          durationAverage: 12.34567,
          durationMaximum: 30,
          durationP50: 10,
          durationP95: 28.5,
          durationP99: 29.7,
        },
      ],
      [{ bucket: at('2026-10-19T09:05:00Z'), maximum: 3, minuteSum: 7 }],
    );

    expect(view.timestamps).toEqual([new Date('2026-10-19T09:00:00Z'), new Date('2026-10-19T09:05:00Z'), new Date('2026-10-19T09:10:00Z')]);
    expect(view.metrics).toEqual({
      Invocations: [0, 4, 0],
      Errors: [0, 1, 0],
      Throttles: [0, 2, 0],
      ColdStarts: [0, 1, 0],
      Duration: { Average: [null, 12.346, null], Maximum: [null, 30, null], p50: [null, 10, null], p95: [null, 28.5, null], p99: [null, 29.7, null] },
      // The mean over the period's five minutes: 7 instance-minutes, 1.4 instances.
      Instances: { Maximum: [0, 3, 0], Average: [0, 1.4, 0] },
    });
    expect([view.period, view.start, view.end]).toEqual([300, window.start, window.end]);
  });
});

describe('RefusedInvocationsService', () => {
  let query: jest.Mock;
  let service: RefusedInvocationsService;

  beforeEach(() => {
    query = jest.fn(async () => []);
    service = new RefusedInvocationsService({ query } as unknown as DataSource);
  });

  it("counts each function's refused calls per minute, and writes them at once, for the account's own functions only", async () => {
    service.count('000000000001', FN, new Date('2026-10-19T10:07:01Z'));
    service.count('000000000001', FN.toUpperCase(), new Date('2026-10-19T10:07:59Z'));
    service.count('000000000001', FN, new Date('2026-10-19T10:08:00Z'));

    await service.flush();

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, [ids, minutes, accounts, counts]] = query.mock.calls[0] as [string, [string[], Date[], string[], number[]]];
    expect(sql).toContain('JOIN "functions" f ON f."id" = v."function_id" AND f."account_id" = v."account_id"');
    expect(sql).toContain('DO UPDATE SET "count" = "rate_limited_invocations"."count" + EXCLUDED."count"');
    expect([ids, minutes, accounts, counts]).toEqual([
      [FN, FN],
      [new Date('2026-10-19T10:07:00Z'), new Date('2026-10-19T10:08:00Z')],
      ['000000000001', '000000000001'],
      [2, 1],
    ]);

    await service.flush(); // nothing left
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps another account's refusals for the same function apart, so that the write can drop them", async () => {
    const at = new Date('2026-10-19T10:07:01Z');
    service.count('000000000001', FN, at);
    service.count('000000000002', FN, at);

    await service.flush();

    const [, [ids, , accounts, counts]] = query.mock.calls[0] as [string, [string[], Date[], string[], number[]]];
    expect([ids, accounts, counts]).toEqual([[FN, FN], ['000000000001', '000000000002'], [1, 1]]);
  });

  it("ignores a path that names no function, and holds no more than it may: a flood of made-up IDs can't fill the memory", async () => {
    service.count('000000000001', 'not-a-function');
    service.count('000000000001', undefined);
    for (let i = 0; i < MAX_HELD + 5; i++) service.count('000000000001', `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

    await service.flush();

    expect((query.mock.calls[0][1] as unknown[][])[0]).toHaveLength(MAX_HELD);
  });

  it("logs counts it couldn't write, and goes on", async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('connection terminated'));
    service.count('000000000001', FN);

    await expect(service.flush()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith('Could not write 1 count(s) of rate-limited invocations: connection terminated');
    errors.mockRestore();
  });

  it('writes what it holds when the backend stops', async () => {
    service.onModuleInit();
    service.count('000000000001', FN);

    await service.onModuleDestroy();

    expect(query).toHaveBeenCalledTimes(1);
  });
});

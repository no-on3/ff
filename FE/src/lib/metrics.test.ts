import { describe, expect, it } from 'vitest';
import type { Metrics } from '../services/api';
import { METRIC_RANGES, metricRows, metricTotals, milliseconds, pointLabel, rangeQuery } from './metrics';

const VIEW: Metrics = {
  period: 300,
  start: '2026-10-19T09:00:00.000Z',
  end: '2026-10-19T09:15:00.000Z',
  timestamps: ['2026-10-19T09:00:00.000Z', '2026-10-19T09:05:00.000Z', '2026-10-19T09:10:00.000Z'],
  metrics: {
    Invocations: [7, 0, 1],
    Errors: [4, 0, 0],
    Throttles: [7, 0, 1],
    ColdStarts: [2, 0, 0],
    Duration: { Average: [30, null, 7.5], Maximum: [50, null, 7.5], p50: [30, null, 7.5], p95: [48, null, 7.5], p99: [49.6, null, 7.5] },
    Instances: { Maximum: [3, 0, 1], Average: [1, 0, 0.2] },
  },
};

describe('the metrics ranges', () => {
  it('ask for each range ending now, with a period that keeps the chart readable: at most 288 points', () => {
    const now = new Date('2026-10-19T10:00:00Z');
    expect(rangeQuery('1h', now)).toEqual({ period: 60, start: '2026-10-19T09:00:00.000Z', end: '2026-10-19T10:00:00.000Z' });
    expect(rangeQuery('7d', now)).toEqual({ period: 3600, start: '2026-10-12T10:00:00.000Z', end: '2026-10-19T10:00:00.000Z' });
    expect(METRIC_RANGES.map((r) => r.seconds / r.period)).toEqual([60, 72, 288, 168]);
  });
});

describe('metricRows and metricTotals', () => {
  it('give a row per period, with the durations, and the most instances', () => {
    expect(metricRows(VIEW)[0]).toEqual({
      time: '2026-10-19T09:00:00.000Z',
      Invocations: 7,
      Errors: 4,
      Throttles: 7,
      ColdStarts: 2,
      p50: 30,
      p95: 48,
      p99: 49.6,
      Maximum: 50,
      Instances: 3,
    });
    expect(metricRows(VIEW)[1]).toMatchObject({ Invocations: 0, p50: null, Instances: 0 });
  });

  it("add up the range: the errors' share of the calls, the slowest call, the most instances", () => {
    expect(metricTotals(VIEW)).toEqual({ invocations: 8, errors: 4, errorRate: 50, throttles: 8, coldStarts: 2, slowest: 50, peakInstances: 3 });
  });

  it('give no error rate and no slowest call for a range without calls', () => {
    const quiet: Metrics = {
      ...VIEW,
      metrics: { ...VIEW.metrics, Invocations: [0], Errors: [0], Throttles: [0], ColdStarts: [0], Duration: { Average: [null], Maximum: [null], p50: [null], p95: [null], p99: [null] }, Instances: { Maximum: [0], Average: [0] } },
    };
    expect(metricTotals(quiet)).toMatchObject({ invocations: 0, errorRate: null, slowest: null, peakInstances: 0 });
  });
});

describe('to read', () => {
  it('writes milliseconds with a decimal below 100, none above, and a dash for none', () => {
    expect([milliseconds(7.54), milliseconds(1450.6), milliseconds(null)]).toEqual(['7.5 ms', '1,451 ms', '–']);
  });

  it('labels a point with its time on a 24-hour clock, and its day too when the period is an hour', () => {
    // Five past midnight, local time: "00:05", never "12:05 AM" or "24:05".
    const midnight = new Date(2026, 9, 19, 0, 5).toISOString();
    const afternoon = new Date(2026, 9, 19, 15, 0).toISOString();
    expect(pointLabel(midnight, 300)).toMatch(/^00\D05$/);
    expect(pointLabel(afternoon, 60)).toMatch(/^15\D00$/);
    const day = new Date(afternoon).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(day).toContain('19');
    expect(pointLabel(afternoon, 3600)).toBe(`${day} ${pointLabel(afternoon, 60)}`);
  });
});

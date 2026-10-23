import { describe, expect, it } from 'vitest';
import { NO_FILTER, STATUS_INFO, countText, filterFunctions, relativeTime, sparklinePoints } from './function-list';

const functions = [
  { name: 'orders-api', runtime: 'nodejs', status: 'ACTIVE' },
  { name: 'invoice-pdf', runtime: 'python', status: 'ACTIVE' },
  { name: 'Orders-Export', runtime: 'python', status: 'CREATING' },
  { name: 'image-resize', runtime: 'nodejs', status: 'ERROR' },
] as const;
const names = (filter: Partial<typeof NO_FILTER>) => filterFunctions(functions, { ...NO_FILTER, ...filter }).map((fn) => fn.name);

describe('filterFunctions', () => {
  it('keeps every function, in the API order, without a filter', () => {
    expect(names({})).toEqual(['orders-api', 'invoice-pdf', 'Orders-Export', 'image-resize']);
  });

  it('finds part of a name in any case, the spaces around it ignored', () => {
    expect(names({ query: '  ORDERS ' })).toEqual(['orders-api', 'Orders-Export']);
    expect(names({ query: 'pdf' })).toEqual(['invoice-pdf']);
    expect(names({ query: 'nothing' })).toEqual([]);
  });

  it('narrows by runtime and by status, together with the query', () => {
    expect(names({ runtime: 'python' })).toEqual(['invoice-pdf', 'Orders-Export']);
    expect(names({ status: 'ERROR' })).toEqual(['image-resize']);
    expect(names({ query: 'orders', runtime: 'python', status: 'CREATING' })).toEqual(['Orders-Export']);
    expect(names({ query: 'orders', status: 'ERROR' })).toEqual([]);
  });
});

describe('countText', () => {
  it('says how many there are, and how many are shown once filtered', () => {
    expect([countText(6, 6), countText(2, 6), countText(1, 1), countText(0, 1)]).toEqual(['6 functions', '2 of 6 functions', '1 function', '0 of 1 function']);
  });
});

describe('STATUS_INFO', () => {
  it('names every status the API has in a word, with a tone for its pill', () => {
    expect(Object.fromEntries(Object.entries(STATUS_INFO).map(([status, info]) => [status, `${info.label}:${info.tone}`]))).toEqual({
      ACTIVE: 'Active:ok',
      CREATING: 'Creating:busy',
      ERROR: 'Error:failed',
      DELETED: 'Deleted:failed',
    });
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  it.each([
    ['2026-10-22T11:59:30Z', 'just now'],
    ['2026-10-22T12:00:05Z', 'just now'],
    ['2026-10-22T11:55:00Z', '5 min ago'],
    ['2026-10-22T09:00:00Z', '3 h ago'],
    ['2026-10-21T11:00:00Z', '1 day ago'],
    ['2026-10-17T12:00:00Z', '5 days ago'],
  ])('says %s as "%s"', (iso, text) => {
    expect(relativeTime(iso, now)).toBe(text);
  });

  it('gives the date after a week', () => {
    expect(relativeTime('2026-09-30T12:00:00Z', now)).toBe('30 Sept 2026');
  });
});

describe('sparklinePoints', () => {
  it('draws the highest bucket at the top and zero at the bottom, across the width', () => {
    expect(sparklinePoints([0, 5, 10], 100, 20, 3)).toBe('0,20 50,10 100,0');
  });

  it('sums the points into buckets, so that a day of five-minute points draws 48 of them', () => {
    const day = Array.from({ length: 288 }, () => 1);
    expect(sparklinePoints(day, 120, 30).split(' ')).toHaveLength(48);
    expect(sparklinePoints([1, 1, 2, 2], 10, 10, 2)).toBe('0,5 10,0');
  });

  it('draws nothing without points, and a flat line at the bottom when every value is zero', () => {
    expect(sparklinePoints([], 100, 20)).toBe('');
    expect(sparklinePoints([0, 0], 100, 20, 2)).toBe('0,20 100,20');
  });
});

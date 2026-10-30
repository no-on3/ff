import { describe, expect, it } from 'vitest';
import type { CacheMetrics } from '../services/api';
import { DEFAULT_SECRET, STATUS_INFO, cacheNameProblem, cliCommand, memoryShare, readsSummary } from './caches';

describe("a cache's name, as the API takes it", () => {
  it.each(['sessions', 'a', 'rates-2', `a${'b'.repeat(39)}`])('takes %s', (name) => {
    expect(cacheNameProblem(name)).toBeNull();
  });

  it.each(['', 'Sessions', '1-cache', 'two--hyphens', 'last-', 'under_score', `a${'b'.repeat(40)}`])('refuses %j, saying what a name is', (name) => {
    expect(cacheNameProblem(name)).toBe(
      name === ''
        ? 'Give the cache a name'
        : '1 to 40 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS ElastiCache names its clusters',
    );
  });
});

describe("a cache's memory", () => {
  it("gives the share of the plan's memory its keys use, in whole percent; none when the server could not say", () => {
    expect([
      memoryShare({ bytesUsedForCache: 1_258_291, memoryMb: 64 }),
      memoryShare({ bytesUsedForCache: 61_865_984, memoryMb: 64 }),
      memoryShare({ bytesUsedForCache: null, memoryMb: 64 }),
    ]).toEqual([2, 92, null]);
  });
});

describe("a cache's reads", () => {
  const day = (hits: Array<number | null>, misses: Array<number | null>, evictions: Array<number | null>): CacheMetrics => ({
    period: 3600,
    start: '2026-10-29T12:00:00.000Z',
    end: '2026-10-29T15:00:00.000Z',
    timestamps: ['2026-10-29T12:00:00.000Z', '2026-10-29T13:00:00.000Z', '2026-10-29T14:00:00.000Z'],
    metrics: {
      BytesUsedForCache: { Maximum: [null, null, null], Average: [null, null, null] },
      CurrConnections: { Maximum: [null, null, null], Average: [null, null, null] },
      CacheHits: { Sum: hits },
      CacheMisses: { Sum: misses },
      Evictions: { Sum: evictions },
    },
  });

  it('adds up its hours, an hour it was not sampled in counting none, and gives the share of reads that found their key', () => {
    expect(readsSummary(day([900, null, 37], [100, null, 3], [0, null, 12]))).toEqual({ reads: 1040, hitPercent: 90.1, evictions: 12 });
  });

  it('gives no share without a read', () => {
    expect(readsSummary(day([0, null, 0], [0, null, 0], [null, null, null]))).toEqual({ reads: 0, hitPercent: null, evictions: 0 });
  });
});

describe('connecting', () => {
  it('names the secret REDIS_URL by default, and quotes the address for redis-cli', () => {
    expect([DEFAULT_SECRET, cliCommand('rediss://default:pw@cache.example.tn:6400')]).toEqual(['REDIS_URL', 'redis-cli -u "rediss://default:pw@cache.example.tn:6400"']);
  });

  it('says each status as ElastiCache does', () => {
    expect(Object.entries(STATUS_INFO).map(([status, info]) => `${status}:${info.label}`)).toEqual(['creating:Creating', 'active:Available', 'suspended:Suspended', 'deleting:Deleting']);
  });
});

import type { PillTone } from '../components/StatusPill';
import type { Cache, CacheMetrics, CacheStatus } from '../services/api';

/** A cache's name, as the API takes it: AWS ElastiCache's rule for its clusters. contract.test.ts checks it against the API's. */
export const CACHE_NAME = /^[a-z](?:[a-z0-9]|-(?!-)){0,39}$/;

/** Why the API would refuse the name, said before sending it; null when it would take it. */
export function cacheNameProblem(name: string): string | null {
  if (name === '') return 'Give the cache a name';
  if (CACHE_NAME.test(name) && !name.endsWith('-')) return null;
  return '1 to 40 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS ElastiCache names its clusters';
}

/** Each status in a word, as ElastiCache says it, its tone, and what it means. */
export const STATUS_INFO: Record<CacheStatus, { label: string; tone: PillTone; title: string }> = {
  creating: { label: 'Creating', tone: 'busy', title: 'Being made on the server' },
  active: { label: 'Available', tone: 'ok', title: 'It takes connections' },
  suspended: { label: 'Suspended', tone: 'idle', title: "Its user can't log in while the account is suspended; its keys are kept" },
  deleting: { label: 'Deleting', tone: 'busy', title: 'Being deleted, with its keys' },
};

/** How much of its memory its keys use, in whole percent; null when unknown. */
export function memoryShare(cache: Pick<Cache, 'bytesUsedForCache' | 'memoryMb'>): number | null {
  if (cache.bytesUsedForCache === null) return null;
  return Math.round((cache.bytesUsedForCache / (cache.memoryMb * 1_048_576)) * 100);
}

/** Its hours' reads, the share that found their key, and the keys it let go, from its metrics; hours it wasn't sampled in count none. */
export function readsSummary(metrics: CacheMetrics): { reads: number; hitPercent: number | null; evictions: number } {
  const total = (series: Array<number | null>) => series.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const hits = total(metrics.metrics.CacheHits.Sum);
  const reads = hits + total(metrics.metrics.CacheMisses.Sum);
  return { reads, hitPercent: reads === 0 ? null : Math.round((1000 * hits) / reads) / 10, evictions: total(metrics.metrics.Evictions.Sum) };
}

/** The secret a function reads the address from, as apps written for Redis and ElastiCache often do. */
export const DEFAULT_SECRET = 'REDIS_URL';

/** redis-cli, or valkey-cli, which takes the same: TLS, from the address's rediss://. */
export const cliCommand = (url: string): string => `redis-cli -u "${url}"`;

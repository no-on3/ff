/**
 * L2: customers' caches measured every hour (ADR 0013), against a real
 * PostgreSQL server, in a scratch database dropped after; the server of
 * caches is a stand-in that answers what it runs. Each cache it runs is
 * measured once in the hour, a suspended one too, its memory the plan's; one
 * being made or deleted isn't, nor a closed account's; one the server
 * doesn't run is tried again the next minute; two backends at once measure
 * each cache once. Their metrics and bill read these: customer-metrics.db.spec.ts
 * and hourly-rating.db.spec.ts.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { HOUR_MS } from '../billing/rating-hours';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { CacheSamplesService } from './cache-samples.service';
import { CacheServer, CacheUse } from './cache-server';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const A = '500000000031';
const CLOSED = '500000000032';

run("customers' caches measured every hour (L2, ADR 0013)", () => {
  let db: ScratchDatabase;
  /** What the stand-in server runs: each cache's measures, by the server's name for it. */
  const running = new Map<string, CacheUse>();
  /** The names each turn asked the server about. */
  const asked: string[][] = [];
  const server: CacheServer = {
    put: async () => undefined,
    remove: async () => undefined,
    use: async (names) => {
      asked.push(names);
      return new Map(names.flatMap((name): Array<[string, CacheUse]> => (running.has(name) ? [[name, running.get(name) as CacheUse]] : [])));
    },
  };
  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  let n = 0;
  /** A cache of the account, as its row, in the status given: answers its ID and the server's name for it. */
  const cache = async (accountId: string, name: string, status: string, memoryMb = 64) => {
    const serverName = `fc-${String(++n).padStart(24, '0')}`;
    const [{ id }] = await query<Array<{ id: string }>>(
      `INSERT INTO caches (account_id, name, server_name, port, memory_mb, status, password_sha256) VALUES ($1, $2, $3, $4, $5, $6, repeat('0', 64)) RETURNING id`,
      [accountId, name, serverName, 6400 + n, memoryMb, status],
    );
    return { id, serverName };
  };
  const measures = (bytesUsedForCache: number, uptimeSeconds: number): CacheUse => ({
    bytesUsedForCache,
    currConnections: 2,
    cacheHits: 900,
    cacheMisses: 100,
    evictions: 3,
    uptimeSeconds,
  });
  const samplesOf = (cacheId: string) =>
    query<Array<{ hour: Date; name: string; memoryMb: number; bytesUsed: string; connections: number; hits: string; misses: string; evictions: string; startedAt: Date }>>(
      `SELECT hour, name, memory_mb AS "memoryMb", bytes_used::text AS "bytesUsed", connections, hits::text, misses::text, evictions::text, process_started_at AS "startedAt"
         FROM cache_samples WHERE cache_id = $1 ORDER BY hour`,
      [cacheId],
    );
  // The start of this hour, and the hours after it, whenever the suite runs.
  const t0 = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS);
  const at = (hours: number, minutes = 0) => new Date(t0.getTime() + hours * HOUR_MS + minutes * 60_000);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const month of [t0, at(24 * 31)]) await query(`SELECT ff_ensure_month_partition('cache_samples', $1::date)`, [month]);
    await db.dataSource.getRepository(Account).save([
      { id: A, name: 'Cached', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: CLOSED, name: 'Closed', planId: 'beta', status: AccountStatus.CLOSED, dataDeletionDueAt: new Date(Date.now() + 30 * 86_400_000) },
    ]);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('measures each cache the server runs once in the hour, a suspended one too, its memory the plan\'s and its process\'s start from its uptime', async () => {
    const sessions = await cache(A, 'sessions', 'active');
    const rates = await cache(A, 'rates', 'suspended', 128);
    const making = await cache(A, 'making', 'creating');
    const going = await cache(A, 'going', 'deleting');
    const closed = await cache(CLOSED, 'kept', 'active');
    for (const made of [sessions, rates, making, going, closed]) running.set(made.serverName, measures(1_258_291, 3_600));
    const samples = new CacheSamplesService(db.dataSource, server);

    expect(await samples.sampleDue(at(0, 5))).toBe(2);
    expect(asked.at(-1)).toEqual([rates.serverName, sessions.serverName]);
    expect(await samplesOf(sessions.id)).toEqual([
      { hour: t0, name: 'sessions', memoryMb: 64, bytesUsed: '1258291', connections: 2, hits: '900', misses: '100', evictions: '3', startedAt: at(-1, 5) },
    ]);
    expect((await samplesOf(rates.id)).map((sample) => sample.memoryMb)).toEqual([128]);
    expect([await samplesOf(making.id), await samplesOf(going.id), await samplesOf(closed.id)]).toEqual([[], [], []]);

    // Measured in the hour: the next minutes ask the server nothing; the next hour, again.
    const turns = asked.length;
    expect(await samples.sampleDue(at(0, 6))).toBe(0);
    expect(asked.length).toBe(turns);
    expect(await samples.sampleDue(at(1))).toBe(2);
    expect((await samplesOf(sessions.id)).map((sample) => sample.hour)).toEqual([t0, at(1)]);
    await query(`DELETE FROM caches`);
  });

  it("tries a cache the server doesn't run again the next minute: an hour it is never measured in has no sample, and isn't billed", async () => {
    const late = await cache(A, 'late', 'active');
    const samples = new CacheSamplesService(db.dataSource, server);

    expect(await samples.sampleDue(at(2))).toBe(0);
    running.set(late.serverName, measures(0, 2));
    expect(await samples.sampleDue(at(2, 1))).toBe(1);

    expect((await samplesOf(late.id)).map((sample) => [sample.hour, sample.startedAt])).toEqual([[at(2), new Date(at(2, 1).getTime() - 2_000)]]);
    await query(`DELETE FROM caches`);
  });

  it('measures each cache once when two backends take their turn at once', async () => {
    const made = [await cache(A, 'one', 'active'), await cache(A, 'two', 'active'), await cache(A, 'three', 'active')];
    for (const one of made) running.set(one.serverName, measures(1_000, 60));
    const [first, second] = [new CacheSamplesService(db.dataSource, server), new CacheSamplesService(db.dataSource, server)];

    const counts = await Promise.all([first.sampleDue(at(3)), second.sampleDue(at(3))]);

    expect(counts[0] + counts[1]).toBe(3);
    expect(await query(`SELECT count(*)::int AS n FROM cache_samples WHERE hour = $1`, [at(3)])).toEqual([{ n: 3 }]);
  });
});

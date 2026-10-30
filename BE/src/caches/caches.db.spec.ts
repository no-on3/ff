/**
 * L2: customers' caches on real servers: FF's own PostgreSQL keeps the rows, in
 * a scratch database dropped afterwards, and the server of customers' caches
 * runs them (ADR 0013), its agent reached as FF_CACHE_* name it. An app's
 * connection is made as its own would be, from the address FF gave, over TLS.
 * Every cache the suite makes there is deleted at its end. Skipped without
 * FF_CACHE_HOST.
 *   hack/k8s/cache-up.sh   # prints the FF_CACHE_* lines, for BE/.env or the environment
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { connect } from 'node:tls';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { CacheSettings, databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan, plan } from '../plans/test-fixtures';
import { AgentCacheServer } from './cache-server';
import { Cache, CacheStatus } from './cache.entity';
import { CachesService } from './caches.service';

const env = process.env;
const run = env.FF_DB_IT === '1' && env.FF_CACHE_HOST ? describe : describe.skip;
const A = '510000000011';
const B = '510000000012';

function cacheSettings(): CacheSettings {
  const [first, last] = (env.FF_CACHE_PORTS ?? '6400-6999').split('-').map(Number);
  return {
    host: env.FF_CACHE_HOST as string,
    ports: { first, last },
    agentUrl: env.FF_CACHE_AGENT_URL as string,
    agentToken: env.FF_CACHE_AGENT_TOKEN as string,
    cidrs: [],
    ...(env.FF_CACHE_CA_FILE ? { ca: fs.readFileSync(env.FF_CACHE_CA_FILE, 'utf8') } : {}),
  };
}

/** A command's reply, as Valkey's protocol (RESP 2) gives it: a string, a number, null, an error, or a list. */
type Reply = string | number | null | Error | Reply[];

/** An app's connection from the address FF gave, as redis and ioredis make one: TLS, the server's CA when it isn't public, AUTH. */
async function open(url: string, ca: string | undefined): Promise<{ send: (...args: string[]) => Promise<Reply>; closed: Promise<void>; end: () => void }> {
  const { hostname, port, username, password } = new URL(url);
  const socket = connect({ host: hostname, port: Number(port), ...(ca ? { ca } : {}), servername: /^[\d.]+$/.test(hostname) ? undefined : hostname });
  await new Promise<void>((resolve, reject) => socket.once('secureConnect', () => resolve()).once('error', reject));
  let buffer = Buffer.alloc(0);
  const waiting: Array<(reply: Reply) => void> = [];
  const parse = (at: number): [Reply, number] | undefined => {
    const end = buffer.indexOf('\r\n', at);
    if (end < 0) return undefined;
    const type = String.fromCharCode(buffer[at]);
    const text = buffer.toString('utf8', at + 1, end);
    if (type === '+') return [text, end + 2];
    if (type === '-') return [new Error(text), end + 2];
    if (type === ':') return [Number(text), end + 2];
    if (type === '$') {
      const length = Number(text);
      if (length < 0) return [null, end + 2];
      return buffer.length < end + 4 + length ? undefined : [buffer.toString('utf8', end + 2, end + 2 + length), end + 4 + length];
    }
    const items: Reply[] = [];
    let next = end + 2;
    for (let i = 0; i < Number(text); i++) {
      const item = parse(next);
      if (!item) return undefined;
      items.push(item[0]);
      next = item[1];
    }
    return [items, next];
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let reply = parse(0); reply; reply = parse(0)) {
      buffer = buffer.subarray(reply[1]);
      waiting.shift()?.(reply[0]);
    }
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('error', () => undefined);
  const send = (...args: string[]) =>
    new Promise<Reply>((resolve, reject) => {
      if (socket.destroyed) return reject(new Error('connection closed'));
      waiting.push(resolve);
      socket.write(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`);
    });
  const auth = await send('AUTH', decodeURIComponent(username || 'default'), decodeURIComponent(password));
  if (auth instanceof Error) {
    socket.end();
    throw auth;
  }
  return { send, closed, end: () => socket.end() };
}

run("customers' caches, on the server of customers' caches (L2)", () => {
  let db: ScratchDatabase;
  const settings = cacheSettings();
  const server = new AgentCacheServer(settings);
  const policies: string[] = [];
  const service = (limits = {}) =>
    new CachesService(
      db.dataSource.getRepository(Cache),
      server,
      { applyTenantLimits: async (accountId: string) => void policies.push(accountId) } as unknown as Orchestrator,
      onePlan(plan({ caches: 2, cacheMb: 8, ...limits })),
      { record: async () => undefined } as never,
      { get: () => settings } as unknown as ConfigService,
    );
  const reached = (url: string) => open(url, settings.ca);
  const status = async (accountId: string, status: AccountStatus) => db.dataSource.getRepository(Account).update({ id: accountId }, { status });

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [A, B]) await db.dataSource.getRepository(Account).save({ id, name: id, planId: 'beta', status: AccountStatus.ACTIVE });
  });

  afterAll(async () => {
    for (const row of await db.dataSource.getRepository(Cache).find()) await server.remove(row.serverName).catch(() => undefined);
    await db?.drop();
  });

  it('makes a cache at a port of its own, its address shown once, which an app reaches over TLS with the plan\'s memory', async () => {
    const made = await service().create(A, { name: 'sessions' });

    expect(made).toMatchObject({ name: 'sessions', status: CacheStatus.ACTIVE, host: settings.host, memoryMb: 8, engine: 'Valkey 9.1' });
    expect(made.url).toBe(`rediss://default:${made.password}@${settings.host}:${made.port}`);
    expect(made.port).toBeGreaterThanOrEqual(settings.ports.first);
    expect(policies).toContain(A);
    const app = await reached(made.url);
    expect([await app.send('SET', 'cart:42', 'two croissants'), await app.send('GET', 'cart:42')]).toEqual(['OK', 'two croissants']);
    expect(await app.send('CONFIG', 'GET', 'maxmemory')).toEqual(expect.objectContaining({ message: expect.stringMatching(/^NOPERM/) }));
    app.end();
    const [row] = await db.dataSource.getRepository(Cache).findBy({ accountId: A, name: 'sessions' });
    expect(row.passwordSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(made.password);
  });

  it("lists the account's caches with their memory used and connections, never another account's", async () => {
    const app = await reached((await service().resetPassword(A, 'sessions')).url);
    const [listed] = await service().list(A);

    expect(listed).toMatchObject({ name: 'sessions', status: 'active' });
    expect(listed.bytesUsedForCache).toBeGreaterThan(0);
    expect(listed.currConnections).toBeGreaterThanOrEqual(1);
    expect(listed).not.toHaveProperty('password');
    expect(await service().list(B)).toEqual([]);
    await expect(service().get(B, 'sessions')).rejects.toThrow(new NotFoundException('The account has no cache sessions'));
    app.end();
  });

  it('refuses a second cache of a name, and one past the plan', async () => {
    await expect(service().create(A, { name: 'sessions' })).rejects.toThrow(new ConflictException('The account has a cache named "sessions" already'));
    await expect(service({ caches: 1 }).create(A, { name: 'rates' })).rejects.toThrow(new BadRequestException('The Beta plan allows 1 cache, and the account has 1: delete one first'));
  });

  it('gives a new password at once: the old one refused for new connections, those under way kept', async () => {
    const before = await service().resetPassword(A, 'sessions');
    const app = await reached(before.url);
    const after = await service().resetPassword(A, 'sessions');

    await expect(reached(before.url)).rejects.toThrow(/WRONGPASS/);
    expect(await app.send('PING')).toBe('PONG');
    const again = await reached(after.url);
    expect(await again.send('GET', 'cart:42')).toBe('two croissants');
    app.end();
    again.end();
  });

  it("keeps a suspended account's users out, its connections ended, its keys there when it is active again", async () => {
    const made = await service().resetPassword(A, 'sessions');
    const app = await reached(made.url);
    await status(A, AccountStatus.SUSPENDED);
    await service().suspendAccount(A);

    await app.closed;
    await expect(reached(made.url)).rejects.toThrow(/WRONGPASS/);
    expect((await service().get(A, 'sessions')).status).toBe(CacheStatus.SUSPENDED);
    await status(A, AccountStatus.ACTIVE);
    await service().reactivateAccount(A);
    const back = await reached(made.url);
    expect(await back.send('GET', 'cart:42')).toBe('two croissants');
    back.end();
  });

  it('deletes a cache with its keys: its address answers no more, its port free for the next', async () => {
    const made = await service().resetPassword(A, 'sessions');
    await service().remove(A, 'sessions');

    await expect(reached(made.url)).rejects.toThrow();
    await expect(service().get(A, 'sessions')).rejects.toThrow(NotFoundException);
    const next = await service().create(B, { name: 'sessions' });
    expect(next.port).toBe(made.port);
    const app = await reached(next.url);
    expect(await app.send('GET', 'cart:42')).toBeNull();
    app.end();
    expect(await service().deleteAll(B)).toBe(1);
  });
});

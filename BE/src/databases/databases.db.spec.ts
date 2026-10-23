/**
 * L2: customers' databases on real servers: FF's own PostgreSQL keeps the rows,
 * in a scratch database dropped afterwards, and the server of customers'
 * databases makes them (ADR 0008), as FF_DATA_DB_* name it. Every database the
 * suite makes there is dropped at its end. Skipped without FF_DATA_DB_HOST.
 *   hack/k8s/data-db-up.sh   # prints the FF_DATA_DB_* lines, for BE/.env or the environment
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { Client } from 'pg';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { DataDbSettings, databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan, plan } from '../plans/test-fixtures';
import { PostgresDataServer } from './data-server';
import { Database, DatabaseStatus } from './database.entity';
import { DatabasesService } from './databases.service';
import { DatabaseWithPassword } from './dto/database.dto';

const env = process.env;
const run = env.FF_DB_IT === '1' && env.FF_DATA_DB_HOST ? describe : describe.skip;
const A = '500000000011';
const B = '500000000012';

function dataDb(): DataDbSettings {
  const host = env.FF_DATA_DB_HOST as string;
  return {
    host,
    port: Number(env.FF_DATA_DB_PORT ?? 5432),
    adminHost: env.FF_DATA_DB_ADMIN_HOST ?? host,
    adminUser: env.FF_DATA_DB_ADMIN_USER ?? 'ff_admin',
    adminPassword: env.FF_DATA_DB_ADMIN_PASSWORD as string,
    cidrs: [],
    ...(env.FF_DATA_DB_CA_FILE ? { ca: fs.readFileSync(env.FF_DATA_DB_CA_FILE, 'utf8') } : {}),
  };
}

run("customers' databases, on the server of customers' databases (L2)", () => {
  let db: ScratchDatabase;
  let server: PostgresDataServer;
  let admin: Client;
  const settings = dataDb();
  const service = (limits = {}) =>
    new DatabasesService(
      db.dataSource.getRepository(Database),
      server,
      { applyTenantLimits: async () => undefined } as unknown as Orchestrator,
      onePlan(plan(limits)),
      { record: async () => undefined } as never,
      { get: () => settings } as unknown as ConfigService,
    );

  /** A connection as a customer's app makes one: the string FF gave, its CA named when the server's isn't public. */
  const connect = async (connectionString: string): Promise<Client> => {
    const client = new Client({ connectionString: env.FF_DATA_DB_CA_FILE ? `${connectionString}&sslrootcert=${env.FF_DATA_DB_CA_FILE}` : connectionString, connectionTimeoutMillis: 5_000 });
    await client.connect();
    return client;
  };
  const as = async <T>(made: { connectionString: string }, work: (client: Client) => Promise<T>): Promise<T> => {
    const client = await connect(made.connectionString);
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const onServer = async (sql: string, values: unknown[] = []) => (await admin.query(sql, values)).rows as Array<Record<string, unknown>>;
  const swapped = (made: DatabaseWithPassword, other: DatabaseWithPassword) => made.connectionString.replace(`/${made.database}?`, `/${other.database}?`);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [A, B]) await db.dataSource.getRepository(Account).save({ id, name: id, planId: 'beta', status: AccountStatus.ACTIVE });
    server = new PostgresDataServer(settings);
    admin = new Client({
      host: settings.adminHost,
      port: settings.port,
      user: settings.adminUser,
      password: settings.adminPassword,
      database: 'postgres',
      ssl: settings.ca ? { ca: settings.ca } : true,
    });
    await admin.connect();
  });

  afterAll(async () => {
    // Whatever a test left on the server goes, by the rows that name it.
    if (db) for (const row of await db.dataSource.getRepository(Database).find()) await server.drop(row.dbName).catch(() => undefined);
    await admin?.end();
    await server?.close();
    await db?.drop();
  });

  it('makes a database its user owns, which the connection string reaches over TLS, PUBLIC kept out', async () => {
    const made = await service().create(A, { name: 'orders' });

    const found = await as(made, async (client) => {
      await client.query('CREATE TABLE orders (id int PRIMARY KEY)');
      await client.query('INSERT INTO orders VALUES (1), (2)');
      return (await client.query('SELECT current_user AS "user", current_database() AS "database", (SELECT count(*)::int FROM orders) AS "rows", (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS "tls"')).rows[0];
    });

    expect(found).toEqual({ user: made.database, database: made.database, rows: 2, tls: true });
    expect(await onServer(`SELECT pg_get_userbyid(datdba) AS "owner", has_database_privilege('public', datname, 'CONNECT') AS "public" FROM pg_database WHERE datname = $1`, [made.database])).toEqual([
      { owner: made.database, public: false },
    ]);
    expect(await onServer(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolconnlimit FROM pg_roles WHERE rolname = $1`, [made.database])).toEqual([
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolconnlimit: 10 },
    ]);
    await service().remove(A, made.id);
  });

  it("keeps accounts apart: one account's user gets into no other database, a name may be in both, and once in each", async () => {
    const a = await service().create(A, { name: 'shop' });
    const b = await service().create(B, { name: 'shop' });

    await expect(as({ connectionString: swapped(a, b) }, async () => 'in')).rejects.toThrow(/pg_hba\.conf rejects connection/);
    await expect(as({ connectionString: swapped(b, a) }, async () => 'in')).rejects.toThrow(/pg_hba\.conf rejects connection/);
    await expect(service({ databases: 2 }).create(A, { name: 'shop' })).rejects.toThrow(new ConflictException('The account has a database named "shop" already'));
    expect((await service().list(A)).map((view) => view.name)).toEqual(['shop']);
    await service().remove(A, a.id);
    await service().remove(B, b.id);
  });

  it("refuses a database past the plan, two at once included: the account's lock counts them one after the other", async () => {
    const results = await Promise.allSettled([service({ databases: 1 }).create(A, { name: 'first' }), service({ databases: 1 }).create(A, { name: 'second' })]);

    const made = results.filter((result) => result.status === 'fulfilled');
    expect(made).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: new BadRequestException('The Beta plan allows 1 database, and the account has 1: delete one first'),
    });
    await service().remove(A, made[0].value.id);
  });

  it('gives a new password: the old one opens no new session, the new one does', async () => {
    const made = await service().create(A, { name: 'rotated' });

    const changed = await service().resetPassword(A, made.id);

    expect(changed.password).not.toBe(made.password);
    await expect(as(made, async () => 'in')).rejects.toThrow(/password authentication failed/);
    await expect(as(changed, async (client) => (await client.query('SELECT 1 AS "one"')).rows[0].one)).resolves.toBe(1);
    await service().remove(A, made.id);
  });

  it("keeps a suspended account's user out, ending its sessions, and lets it in again with its data", async () => {
    const made = await service().create(A, { name: 'paused' });
    await as(made, (client) => client.query('CREATE TABLE kept (x int); INSERT INTO kept VALUES (7)'));
    const open = await connect(made.connectionString);
    open.on('error', () => undefined);

    await service().suspendAccount(A);

    // The server ended it: node-postgres saw the connection close, and takes no more queries on it.
    await expect(open.query('SELECT 1')).rejects.toThrow(/terminat|not queryable/);
    await expect(as(made, async () => 'in')).rejects.toThrow(/is not permitted to log in/);
    expect((await service().get(A, made.id)).status).toBe(DatabaseStatus.SUSPENDED);
    await service().reactivateAccount(A);
    await expect(as(made, async (client) => (await client.query('SELECT x FROM kept')).rows[0].x)).resolves.toBe(7);
    expect((await service().get(A, made.id)).status).toBe(DatabaseStatus.ACTIVE);
    await service().remove(A, made.id);
  });

  it("keeps a user out while FF has the account's storage off, an account reactivated too, makes no database then, and lets it in once storage is on", async () => {
    const made = await service().create(A, { name: 'switched' });
    const storage = (reason: string | null) =>
      db.dataSource.query(`UPDATE accounts SET storage_disabled_at = $2, storage_disabled_reason = $3 WHERE id = $1`, [A, reason ? new Date() : null, reason]);

    await storage('Files shared against our terms');
    await service().applyAccess(A);
    await expect(as(made, async () => 'in')).rejects.toThrow(/is not permitted to log in/);
    await service().reactivateAccount(A); // as an operator reactivating the account would: storage is still off
    await expect(as(made, async () => 'in')).rejects.toThrow(/is not permitted to log in/);
    await expect(service({ databases: 2 }).create(A, { name: 'another' })).rejects.toThrow("FF turned this account's databases and buckets off: Files shared against our terms");

    await storage(null);
    await service().applyAccess(A);
    await expect(as(made, async (client) => (await client.query('SELECT 1 AS "one"')).rows[0].one)).resolves.toBe(1);
    expect((await service().get(A, made.id)).status).toBe(DatabaseStatus.ACTIVE);
    await service().remove(A, made.id);
  });

  it('tells its size and sessions now', async () => {
    const made = await service().create(A, { name: 'measured' });
    const open = await connect(made.connectionString);

    const view = await service().get(A, made.id);

    expect(view.sizeBytes).toBeGreaterThan(1_000_000);
    expect(view.connections).toBe(1);
    await open.end();
    await service().remove(A, made.id);
  });

  it("deletes a database and its user from the server, its sessions ended, and a closed account's all at once", async () => {
    const made = await service().create(A, { name: 'gone' });
    const open = await connect(made.connectionString);
    open.on('error', () => undefined);

    await service().remove(A, made.id);

    expect(await onServer(`SELECT (SELECT count(*)::int FROM pg_database WHERE datname = $1) AS "databases", (SELECT count(*)::int FROM pg_roles WHERE rolname = $1) AS "users"`, [made.database])).toEqual([
      { databases: 0, users: 0 },
    ]);
    await expect(open.query('SELECT 1')).rejects.toThrow();
    const closing = [await service({ databases: 2 }).create(B, { name: 'one' }), await service({ databases: 2 }).create(B, { name: 'two' })];
    await expect(service().deleteAll(B)).resolves.toBe(2);
    expect(await onServer(`SELECT count(*)::int AS "left" FROM pg_database WHERE datname = ANY($1)`, [closing.map((d) => d.database)])).toEqual([{ left: 0 }]);
    expect(await db.dataSource.getRepository(Database).countBy({ accountId: B })).toBe(0);
  });
});

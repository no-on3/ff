/**
 * L2: customers' databases measured every hour (ADR 0008), on real servers:
 * FF's own PostgreSQL keeps the samples, in a scratch database dropped
 * afterwards, and the server of customers' databases answers their size and
 * sessions. Past the plan's storage, the read-only signal as an app meets it:
 * its sessions ended, a write refused, a session cleaning up, the customer
 * taking the setting away and the next hour setting it again, then its end.
 * Every database the suite makes there is dropped at its end. Skipped without
 * FF_DATA_DB_HOST.
 *   hack/k8s/data-db-up.sh   # prints the FF_DATA_DB_* lines, for BE/.env or the environment
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { Client } from 'pg';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import { HOUR_MS, hourOf } from '../billing/rating-hours';
import { DataDbSettings, databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { NotificationsService } from '../notifications/notifications.service';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { PlanLimits } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { plan } from '../plans/test-fixtures';
import { PostgresDataServer } from './data-server';
import { DatabaseSamplesService } from './database-samples.service';
import { Database, DatabaseStatus } from './database.entity';
import { DatabasesService } from './databases.service';
import { DatabaseWithPassword } from './dto/database.dto';

const env = process.env;
const run = env.FF_DB_IT === '1' && env.FF_DATA_DB_HOST ? describe : describe.skip;
const A = '500000000021';
const CLOSED = '500000000022';
const OWNER = 'owner@samples.test';

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

run("customers' databases measured every hour (L2, ADR 0008)", () => {
  let db: ScratchDatabase;
  let server: PostgresDataServer;
  let admin: Client;
  const settings = dataDb();
  /** The plan every account is on, changed by the tests. */
  let limits: Partial<PlanLimits> = {};
  const plans = {
    forAccount: async () => plan(limits),
    forAccounts: async (ids: string[]) => new Map(ids.map((id) => [id, plan(limits)])),
  } as unknown as PlansService;
  const config = { get: () => settings, getOrThrow: () => ({ consoleUrl: 'https://console.example.tn' }) } as unknown as ConfigService;
  const databases = () =>
    new DatabasesService(
      db.dataSource.getRepository(Database),
      server,
      { applyTenantLimits: async () => undefined } as unknown as Orchestrator,
      plans,
      { record: async () => undefined } as never,
      config,
    );
  const samples = () => new DatabaseSamplesService(db.dataSource, server, plans, new NotificationsService(db.dataSource, {} as AuditService, config), config);
  const t0 = new Date();
  const hour = (n: number) => new Date(t0.getTime() + n * HOUR_MS);

  const connect = async (made: { connectionString: string }): Promise<Client> => {
    const client = new Client({
      connectionString: env.FF_DATA_DB_CA_FILE ? `${made.connectionString}&sslrootcert=${env.FF_DATA_DB_CA_FILE}` : made.connectionString,
      connectionTimeoutMillis: 5_000,
    });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  };
  const as = async <T>(made: DatabaseWithPassword, work: (client: Client) => Promise<T>): Promise<T> => {
    const client = await connect(made);
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const sampled = (databaseId: string) =>
    db.dataSource.query<Array<{ hour: Date; name: string; size: string; connections: number }>>(
      `SELECT hour, name, size_bytes::text AS size, connections FROM database_samples WHERE database_id = $1 ORDER BY hour`,
      [databaseId],
    );
  const row = (id: string) => db.dataSource.getRepository(Database).findOneByOrFail({ id });
  const deliveries = () => db.dataSource.query<Array<{ kind: string; channel: string; target: string; subject: string }>>(
    `SELECT kind, channel, target, payload ->> 'subject' AS subject FROM notification_deliveries WHERE account_id = $1 ORDER BY created_at`,
    [A],
  );

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    for (const id of [A, CLOSED]) await db.dataSource.getRepository(Account).save({ id, name: `Account ${id}`, planId: 'beta', status: AccountStatus.ACTIVE });
    const user = await db.dataSource.getRepository(User).save({ oidcSub: 'kc-owner', email: OWNER, name: null, locale: 'en' });
    await db.dataSource.getRepository(Membership).save({ accountId: A, userId: user.id, role: 'owner' });
    server = new PostgresDataServer(settings);
    admin = new Client({ host: settings.adminHost, port: settings.port, user: settings.adminUser, password: settings.adminPassword, database: 'postgres', ssl: settings.ca ? { ca: settings.ca } : true });
    await admin.connect();
  });

  afterAll(async () => {
    if (db) for (const made of await db.dataSource.getRepository(Database).find()) await server.drop(made.dbName).catch(() => undefined);
    await admin?.end();
    await server?.close();
    await db?.drop();
  });

  afterEach(async () => {
    // Each test's databases go, and their samples stay, as a deleted database's do.
    for (const made of await db.dataSource.getRepository(Database).find()) await server.drop(made.dbName).catch(() => undefined);
    await db.dataSource.getRepository(Database).clear();
    limits = {};
  });

  it("measures each database once an hour: its size and sessions as the server counts them, and its name", async () => {
    const made = await databases().create(A, { name: 'orders' });
    const open = await connect(made);

    expect(await samples().sampleDue(hour(0))).toBe(1);
    expect(await samples().sampleDue(new Date(hour(0).getTime() + 10 * 60_000))).toBe(0); // the hour's sample is taken
    const [{ size }] = (await admin.query<{ size: string }>(`SELECT pg_database_size($1)::text AS size`, [made.database])).rows;
    await open.end();
    expect(await samples().sampleDue(hour(1))).toBe(1);

    const rows = await sampled(made.id);
    expect(rows.map((sample) => [sample.hour, sample.name])).toEqual([
      [hourOf(hour(0)), 'orders'],
      [hourOf(hour(1)), 'orders'],
    ]);
    expect([rows[0].size, rows[0].connections]).toEqual([size, 1]);
    expect(Number(rows[0].size)).toBeGreaterThan(1_000_000);
  });

  it("measures no closed account's database, its data waiting for its deletion date, nor one still being made", async () => {
    const kept = await databases().create(A, { name: 'kept' });
    const closing = await databases().create(CLOSED, { name: 'closing' });
    await db.dataSource.query(`UPDATE accounts SET status = 'closed', data_deletion_due_at = now() + interval '30 days' WHERE id = $1`, [CLOSED]);
    await db.dataSource.query(`INSERT INTO databases (account_id, name, db_name, status) VALUES ($1, 'new', 'ff_000000000000000000000001', 'creating')`, [A]);

    expect(await samples().sampleDue(hour(0))).toBe(1);

    expect([(await sampled(kept.id)).length, (await sampled(closing.id)).length]).toEqual([1, 0]);
    await db.dataSource.query(`UPDATE accounts SET status = 'active', data_deletion_due_at = NULL WHERE id = $1`, [CLOSED]);
  });

  it('turns a database past its plan\'s storage read-only: its sessions ended, a write refused with SQLSTATE 25006, a read answered, its owners told once', async () => {
    const made = await databases().create(A, { name: 'big' });
    await as(made, (client) => client.query('CREATE TABLE notes (body text); INSERT INTO notes VALUES (\'kept\')'));
    const open = await connect(made);
    limits = { databaseStorageMb: 1 }; // an empty database is several MB already

    expect(await samples().sampleDue(hour(0))).toBe(1);

    expect(await row(made.id)).toMatchObject({ status: DatabaseStatus.READ_ONLY, storageNotice: 100 });
    await expect(open.query('SELECT 1')).rejects.toThrow(/terminat|not queryable/);
    const refused = await as(made, (client) => client.query("INSERT INTO notes VALUES ('more')").catch((error: { code?: string; message: string }) => error));
    expect(refused).toMatchObject({ code: '25006', message: 'cannot execute INSERT in a read-only transaction' });
    expect(await as(made, async (client) => (await client.query('SELECT body FROM notes')).rows)).toEqual([{ body: 'kept' }]);
    expect(await deliveries()).toEqual([{ kind: 'database.storage', channel: 'email', target: OWNER, subject: 'Your FF database "big" is past its storage: read-only' }]);
  });

  it('lets a session clean up, and sets the signal again the next hour, after the customer took it away, leaving sessions under way be', async () => {
    const made = await databases().create(A, { name: 'cleaned' });
    await as(made, (client) => client.query("CREATE TABLE notes (body text); INSERT INTO notes VALUES ('one'), ('two')"));
    limits = { databaseStorageMb: 1 };
    await samples().sampleDue(hour(0));

    // A session turns it off for itself and deletes; then takes the setting away for every session. Each its own
    // transaction: one begun read-only stays so.
    await as(made, async (client) => {
      await client.query('SET default_transaction_read_only = off');
      await client.query("DELETE FROM notes WHERE body = 'two'");
      await client.query(`ALTER ROLE "${made.user}" IN DATABASE "${made.database}" RESET default_transaction_read_only`);
    });
    const writing = await connect(made);
    await writing.query("INSERT INTO notes VALUES ('three')"); // read-write again, until the next hour

    expect(await samples().sampleDue(hour(1))).toBe(1);

    await writing.query("INSERT INTO notes VALUES ('four')"); // not ended: a signal, not a wall
    await writing.end();
    const refused = await as(made, (client) => client.query("INSERT INTO notes VALUES ('five')").catch((error: { code?: string }) => error));
    expect(refused).toMatchObject({ code: '25006' });
    expect(await as(made, async (client) => (await client.query('SELECT body FROM notes ORDER BY body')).rows.map((r) => r.body))).toEqual(['four', 'one', 'three']);
    // One e-mail for the whole time it stayed past the plan.
    expect((await deliveries()).filter((delivery) => delivery.subject.includes('"cleaned"'))).toHaveLength(1);
  });

  it('ends the signal once the database is back under its plan: read-write again, and no notice kept', async () => {
    const made = await databases().create(A, { name: 'grown' });
    limits = { databaseStorageMb: 1 };
    await samples().sampleDue(hour(0));
    limits = { databaseStorageMb: 1024 }; // a bigger plan

    await samples().sampleDue(hour(1));

    expect(await row(made.id)).toMatchObject({ status: DatabaseStatus.ACTIVE, storageNotice: null });
    const written = await as(made, async (client) => {
      await client.query('CREATE TABLE t (x int)');
      await client.query('INSERT INTO t VALUES (1)');
      return (await client.query('SELECT count(*)::int AS n FROM t')).rows;
    });
    expect(written).toEqual([{ n: 1 }]);
  });
});

import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataDbSettings } from '../config/configuration';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { onePlan, plan } from '../plans/test-fixtures';
import { DataServer } from './data-server';
import { SERVER_NAME } from './database-names';
import { Database, DatabaseStatus } from './database.entity';
import { DatabasesService, NO_DATA_SERVER } from './databases.service';

const ACCOUNT = '500000000001';
const SETTINGS: DataDbSettings = { host: 'db.ff.example', port: 5432, adminHost: 'db.ff.example', adminUser: 'ff_admin', adminPassword: 'x', cidrs: ['203.0.113.20/32'] };

/** The rows a repository holds, with the few calls the service makes. */
function fakeRepository() {
  const rows: Database[] = [];
  const manager = {
    findOne: async () => ({ id: ACCOUNT }),
    countBy: async () => rows.filter((row) => row.accountId === ACCOUNT).length,
    create: (_entity: unknown, values: Partial<Database>) => values,
    save: async (_entity: unknown, values: Partial<Database>) => {
      const row = { id: `db-${rows.length + 1}`, createdAt: new Date(), passwordSetAt: null, server: 'default', ...values } as Database;
      rows.push(row);
      return row;
    },
  };
  return {
    rows,
    repository: {
      manager: { transaction: async (work: (m: typeof manager) => Promise<unknown>) => work(manager) },
      update: async (criteria: { id: string }, values: Partial<Database>) => Object.assign(rows.find((row) => row.id === criteria.id) as Database, values),
      delete: async (criteria: { id: string }) => void rows.splice(rows.findIndex((row) => row.id === criteria.id), 1),
      // As TypeORM's In() and Not() select the rows, by status.
      find: async ({ where }: { where: { status?: { _type: string; _value: unknown } } }) =>
        rows.filter((row) => {
          const status = where.status;
          if (!status) return true;
          return status._type === 'in' ? (status._value as string[]).includes(row.status) : status._type === 'not' ? row.status !== status._value : true;
        }),
      findOne: async ({ where }: { where: { id: string } }) => rows.find((row) => row.id === where.id) ?? null,
    },
  };
}

function fakeServer(overrides: Partial<DataServer> = {}) {
  const calls: string[] = [];
  const server: DataServer = {
    create: async (name) => void calls.push(`create ${name}`),
    setPassword: async (name) => void calls.push(`password ${name}`),
    setConnectionLimit: async () => undefined,
    setLogin: async (name, allowed) => void calls.push(`${allowed ? 'login' : 'nologin'} ${name}`),
    setReadOnly: async (name, readOnly) => void calls.push(`${readOnly ? 'read-only' : 'read-write'} ${name}`),
    drop: async (name) => void calls.push(`drop ${name}`),
    use: async () => new Map(),
    ...overrides,
  };
  return { server, calls };
}

const config = (settings: DataDbSettings | null) => ({ get: () => settings }) as unknown as ConfigService;
const audit = { record: jest.fn(async () => undefined) };
const orchestrator = { applyTenantLimits: jest.fn(async () => undefined) } as unknown as Orchestrator;

describe('DatabasesService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    audit.record.mockClear();
  });

  it('gives the password and the connection string once, with sslmode=require, and opens the account\'s network policy', async () => {
    const { repository, rows } = fakeRepository();
    const { server, calls } = fakeServer();
    const service = new DatabasesService(repository as never, server, orchestrator, onePlan(), audit as never, config(SETTINGS));

    const made = await service.create(ACCOUNT, { name: 'orders' });

    expect(made.database).toMatch(SERVER_NAME);
    expect(made.user).toBe(made.database);
    expect(made.connectionString).toBe(`postgresql://${made.database}:${made.password}@db.ff.example:5432/${made.database}?sslmode=require`);
    expect(made.connectionUrl).toBe(`postgresql://${made.database}@db.ff.example:5432/${made.database}?sslmode=require`);
    expect([made.status, made.connectionLimit, made.storageLimitMb]).toEqual([DatabaseStatus.ACTIVE, 10, 1024]);
    expect(calls).toEqual([`create ${made.database}`]);
    expect(rows.map((row) => row.status)).toEqual([DatabaseStatus.ACTIVE]);
    expect(orchestrator.applyTenantLimits).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ internetEgress: false }));
    expect(audit.record).toHaveBeenCalledWith({ accountId: ACCOUNT, action: 'database.create', resource: `database:${rows[0].id}`, details: { name: 'orders', database: made.database } });
  });

  it('undoes what the server made, and the row, when the server fails: nothing is left, and the caller may try again', async () => {
    const { repository, rows } = fakeRepository();
    const { server, calls } = fakeServer({ create: async () => Promise.reject(new Error('disk full')) });
    const service = new DatabasesService(repository as never, server, orchestrator, onePlan(), audit as never, config(SETTINGS));

    await expect(service.create(ACCOUNT, { name: 'orders' })).rejects.toThrow(ServiceUnavailableException);

    expect(calls).toEqual([expect.stringMatching(/^drop ff_[0-9a-f]{24}$/)]);
    expect(rows).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 503 without a server, whatever is asked but the list, which shows what FF has', async () => {
    const { repository } = fakeRepository();
    const service = new DatabasesService(repository as never, null, orchestrator, onePlan(), audit as never, config(null));

    await expect(service.create(ACCOUNT, { name: 'orders' })).rejects.toThrow(new ServiceUnavailableException(NO_DATA_SERVER));
    await expect(service.list(ACCOUNT)).resolves.toEqual([]);
  });

  it('brackets an IPv6 server in connection strings', async () => {
    const { repository } = fakeRepository();
    const service = new DatabasesService(repository as never, fakeServer().server, orchestrator, onePlan(), audit as never, config({ ...SETTINGS, host: '2001:db8::20' }));

    const made = await service.create(ACCOUNT, { name: 'orders' });

    expect(made.connectionString).toContain('@[2001:db8::20]:5432/');
  });

  it("keeps a suspended account's users out and lets them in again, each on its own: one that fails is logged, the others go on", async () => {
    const { repository, rows } = fakeRepository();
    const failing = { name: '' };
    const { server, calls } = fakeServer({
      setLogin: async (name, allowed) => {
        if (name === failing.name) throw new Error('server away');
        calls.push(`${allowed ? 'login' : 'nologin'} ${name}`);
      },
    });
    const service = new DatabasesService(repository as never, server, orchestrator, onePlan(plan({ databases: 2 })), audit as never, config(SETTINGS));
    const first = await service.create(ACCOUNT, { name: 'first' });
    const second = await service.create(ACCOUNT, { name: 'second' });
    calls.length = 0;
    failing.name = first.database;

    await service.suspendAccount(ACCOUNT);

    expect(calls).toEqual([`nologin ${second.database}`]);
    expect(rows.map((row) => row.status)).toEqual([DatabaseStatus.ACTIVE, DatabaseStatus.SUSPENDED]);
    failing.name = '';
    await service.reactivateAccount(ACCOUNT);
    // Read-write again, as if it had been past the plan before: the next hourly sample says.
    expect(calls).toEqual([`nologin ${second.database}`, `login ${second.database}`, `read-write ${second.database}`]);
    expect(rows.map((row) => row.status)).toEqual([DatabaseStatus.ACTIVE, DatabaseStatus.ACTIVE]);
  });
});

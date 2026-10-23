import { Pool } from 'pg';
import { DataDbSettings } from '../config/configuration';
import { PostgresDataServer } from './data-server';

const NAME = 'ff_0123456789abcdef01234567';
const VERIFIER = 'SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVk:c2VydmVy';
const SETTINGS: DataDbSettings = { host: 'db.ff.example', port: 5432, adminHost: '10.0.5.4', adminUser: 'ff_admin', adminPassword: 'x', cidrs: ['10.0.5.4/32'] };

/** A pool that keeps every statement, in order, and answers the existence check as told. */
function fakePool(exists = { role: true, database: true }) {
  const statements: string[] = [];
  const released: boolean[] = [];
  const query = async (sql: string) => {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: sql.includes('EXISTS') ? [exists] : [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: (broken?: boolean) => released.push(Boolean(broken)) }),
    on: () => undefined,
    end: async () => undefined,
  };
  return { pool: pool as unknown as Pool, statements, released };
}

describe("customers' database server, the statements it is sent (ADR 0008)", () => {
  it('makes the user with its limit and verifier, lets the backend act as it, makes its database, and revokes PUBLIC as its owner', async () => {
    const { pool, statements, released } = fakePool();

    await new PostgresDataServer(SETTINGS, pool).create(NAME, VERIFIER, 10);

    expect(statements).toEqual([
      `CREATE ROLE "${NAME}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD '${VERIFIER}'`,
      `GRANT "${NAME}" TO "ff_admin" WITH INHERIT FALSE, SET TRUE`,
      `CREATE DATABASE "${NAME}" OWNER "${NAME}"`,
      `SET ROLE "${NAME}"`,
      `REVOKE ALL ON DATABASE "${NAME}" FROM PUBLIC`,
      'RESET ROLE',
    ]);
    expect(released).toEqual([false]);
  });

  it('drops the database as its owner, ends the user\'s sessions, then drops the user', async () => {
    const { pool, statements } = fakePool();

    await new PostgresDataServer(SETTINGS, pool).drop(NAME);

    expect(statements.slice(1)).toEqual([
      `SET ROLE "${NAME}"`,
      `DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`,
      'RESET ROLE',
      'SELECT count(pg_terminate_backend("pid")) FROM "pg_stat_activity" WHERE "usename" = $1 AND "pid" <> pg_backend_pid()',
      `DROP ROLE IF EXISTS "${NAME}"`,
    ]);
  });

  it('drops only what the server has: a user whose database never got made, or nothing at all', async () => {
    const userOnly = fakePool({ role: true, database: false });
    const nothing = fakePool({ role: false, database: false });

    await new PostgresDataServer(SETTINGS, userOnly.pool).drop(NAME);
    await new PostgresDataServer(SETTINGS, nothing.pool).drop(NAME);

    expect(userOnly.statements.slice(1).map((sql) => sql.split(' ').slice(0, 2).join(' '))).toEqual(['SELECT count(pg_terminate_backend("pid"))', 'DROP ROLE']);
    expect(nothing.statements).toHaveLength(1);
  });

  it('turns new sessions read-only as the user\'s setting in its database, ending those under way; back, resets it', async () => {
    const { pool, statements } = fakePool();
    const server = new PostgresDataServer(SETTINGS, pool);

    await server.setReadOnly(NAME, true);
    await server.setReadOnly(NAME, false);

    expect(statements).toEqual([
      `ALTER ROLE "${NAME}" IN DATABASE "${NAME}" SET default_transaction_read_only = on`,
      expect.stringContaining('pg_terminate_backend'),
      `ALTER ROLE "${NAME}" IN DATABASE "${NAME}" RESET default_transaction_read_only`,
    ]);
  });

  it('keeps a suspended user out and ends its sessions; lets it in again', async () => {
    const { pool, statements } = fakePool();
    const server = new PostgresDataServer(SETTINGS, pool);

    await server.setLogin(NAME, false);
    await server.setLogin(NAME, true);

    expect(statements).toEqual([`ALTER ROLE "${NAME}" NOLOGIN`, expect.stringContaining('pg_terminate_backend'), `ALTER ROLE "${NAME}" LOGIN`]);
  });

  it('sends a password only as its SCRAM verifier, and a name only as FF makes them, before any statement', async () => {
    const { pool, statements } = fakePool();
    const server = new PostgresDataServer(SETTINGS, pool);

    await expect(server.setPassword(NAME, 'plain-password')).rejects.toThrow('as its SCRAM verifier only');
    await expect(server.create('orders"; DROP DATABASE x; --', VERIFIER, 10)).rejects.toThrow("Not a database name of FF's");
    await expect(server.create(NAME, VERIFIER, 0)).rejects.toThrow('A connection limit must be a whole number above 0');
    await expect(server.use(['postgres'])).rejects.toThrow("Not a database name of FF's");

    expect(statements).toEqual([]);
  });

  it("never gives the pool back a connection that failed between SET ROLE and RESET ROLE", async () => {
    const { pool, released } = fakePool();
    const failing = { ...pool, connect: async () => ({ query: async (sql: string) => {
      if (sql.startsWith('REVOKE')) throw new Error('lost');
      return { rows: [] };
    }, release: (broken?: boolean) => released.push(Boolean(broken)) }) } as unknown as Pool;

    await expect(new PostgresDataServer(SETTINGS, failing).create(NAME, VERIFIER, 10)).rejects.toThrow('lost');

    expect(released).toEqual([true]);
  });
});

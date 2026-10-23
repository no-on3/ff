import { Logger } from '@nestjs/common';
import { Pool, PoolClient, escapeIdentifier, escapeLiteral } from 'pg';
import { DataDbSettings } from '../config/configuration';
import { SERVER_NAME } from './database-names';

/** Injection token for the server of customers' databases; null when FF has none (no FF_DATA_DB_HOST). */
export const DATA_SERVER = Symbol('DATA_SERVER');

/** A database's use, as the server counts it. */
export interface DatabaseUse {
  sizeBytes: bigint;
  /** Its sessions now. */
  connections: number;
}

/**
 * What the backend does on the server of customers' databases (ADR 0008), with its own role there, never a
 * superuser. Every name is a database's and its user's, the same, ff_ and 24 hexadecimal characters.
 */
export interface DataServer {
  /** A user and its database, the user its owner with its connection limit, PUBLIC's rights on the database revoked. */
  create(name: string, verifier: string, connectionLimit: number): Promise<void>;
  /** A new password, as its SCRAM verifier. */
  setPassword(name: string, verifier: string): Promise<void>;
  setConnectionLimit(name: string, connectionLimit: number): Promise<void>;
  /** Whether its user may log in; when it may not, its sessions end. */
  setLogin(name: string, allowed: boolean): Promise<void>;
  /**
   * Its new sessions read-only, or not. When they turn read-only, the sessions under way end, so that each starts so
   * again; `endSessions` false sets it again and leaves them be.
   */
  setReadOnly(name: string, readOnly: boolean, endSessions?: boolean): Promise<void>;
  /** The database and its user, gone, its sessions ended; nothing for one that doesn't exist. */
  drop(name: string): Promise<void>;
  /** The size and sessions of each of these databases the server has. */
  use(names: string[]): Promise<Map<string, DatabaseUse>>;
}

/** A name the backend made, checked before it goes into a statement. */
function quoted(name: string): string {
  if (!SERVER_NAME.test(name)) throw new Error(`Not a database name of FF's: ${JSON.stringify(name)}`);
  return escapeIdentifier(name);
}

const connectionLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`A connection limit must be a whole number above 0, not ${limit}`);
  return limit;
};

const verifierLiteral = (verifier: string): string => {
  if (!verifier.startsWith('SCRAM-SHA-256$')) throw new Error('A password reaches the server as its SCRAM verifier only');
  return escapeLiteral(verifier);
};

/** The server, through a small pool of connections to its maintenance database as the backend's role, over TLS. */
export class PostgresDataServer implements DataServer {
  private readonly logger = new Logger(PostgresDataServer.name);
  private readonly pool: Pool;
  private readonly admin: string;

  /** `pool` stands in for the server's in unit tests. */
  constructor(settings: DataDbSettings, pool?: Pool) {
    this.admin = settings.adminUser;
    this.pool =
      pool ??
      new Pool({
      host: settings.adminHost,
      port: settings.port,
      user: settings.adminUser,
      password: settings.adminPassword,
      database: 'postgres',
      // Always TLS, the certificate checked: against the server's CA when it isn't a public one.
      ssl: settings.ca ? { ca: settings.ca, rejectUnauthorized: true } : { rejectUnauthorized: true },
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      application_name: 'ff-backend',
      });
    this.pool.on('error', (error) => this.logger.warn(`A connection to customers' database server failed: ${error.message}`));
  }

  async create(name: string, verifier: string, limit: number): Promise<void> {
    const id = quoted(name);
    await this.withClient(async (client) => {
      await client.query(
        `CREATE ROLE ${id} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${connectionLimit(limit)} PASSWORD ${verifierLiteral(verifier)}`,
      );
      // PostgreSQL 16 and later: CREATE DATABASE … OWNER needs the right to act as the owner, which CREATEROLE alone
      // doesn't give; never its rights by default.
      await client.query(`GRANT ${id} TO ${escapeIdentifier(this.admin)} WITH INHERIT FALSE, SET TRUE`);
      await client.query(`CREATE DATABASE ${id} OWNER ${id}`);
      // Only the owner can take PUBLIC's rights away: as the backend's role, it changes nothing.
      await this.asOwner(client, name, () => client.query(`REVOKE ALL ON DATABASE ${id} FROM PUBLIC`));
    });
  }

  async setPassword(name: string, verifier: string): Promise<void> {
    await this.pool.query(`ALTER ROLE ${quoted(name)} PASSWORD ${verifierLiteral(verifier)}`);
  }

  async setConnectionLimit(name: string, limit: number): Promise<void> {
    await this.pool.query(`ALTER ROLE ${quoted(name)} CONNECTION LIMIT ${connectionLimit(limit)}`);
  }

  async setLogin(name: string, allowed: boolean): Promise<void> {
    await this.pool.query(`ALTER ROLE ${quoted(name)} ${allowed ? 'LOGIN' : 'NOLOGIN'}`);
    if (!allowed) await this.endSessions(name);
  }

  async setReadOnly(name: string, readOnly: boolean, endSessions = readOnly): Promise<void> {
    const id = quoted(name);
    // The user's setting in its database, which its admin may set; the database's own needs its owner.
    await this.pool.query(
      readOnly ? `ALTER ROLE ${id} IN DATABASE ${id} SET default_transaction_read_only = on` : `ALTER ROLE ${id} IN DATABASE ${id} RESET default_transaction_read_only`,
    );
    if (readOnly && endSessions) await this.endSessions(name);
  }

  async drop(name: string): Promise<void> {
    const id = quoted(name);
    await this.withClient(async (client) => {
      const { rows } = await client.query<{ role: boolean; database: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS "role", EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS "database"`,
        [name],
      );
      if (rows[0].database) {
        // Only its owner may drop it; FORCE ends its sessions first.
        await this.asOwner(client, name, () => client.query(`DROP DATABASE IF EXISTS ${id} WITH (FORCE)`));
      }
      if (rows[0].role) {
        await this.endSessions(name, client);
        await client.query(`DROP ROLE IF EXISTS ${id}`);
      }
    });
  }

  async use(names: string[]): Promise<Map<string, DatabaseUse>> {
    names.forEach(quoted);
    const use = new Map<string, DatabaseUse>();
    if (names.length === 0) return use;
    const { rows } = await this.pool.query<{ name: string; size: string; connections: number }>(
      `SELECT d."datname" AS "name", pg_database_size(d."oid")::text AS "size", coalesce(s."numbackends", 0)::int AS "connections"
         FROM "pg_database" d LEFT JOIN "pg_stat_database" s ON s."datid" = d."oid"
        WHERE d."datname" = ANY($1)`,
      [names],
    );
    for (const row of rows) use.set(row.name, { sizeBytes: BigInt(row.size), connections: row.connections });
    return use;
  }

  /** Closes the pool: the module's end. */
  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Ends the user's sessions, through pg_signal_backend. */
  private async endSessions(name: string, client?: PoolClient): Promise<void> {
    const query = `SELECT count(pg_terminate_backend("pid")) FROM "pg_stat_activity" WHERE "usename" = $1 AND "pid" <> pg_backend_pid()`;
    await (client ?? this.pool).query(query, [name]);
  }

  /** Runs `work` as the database's owner, on this connection, and acts as the backend's role again after, whatever happens. */
  private async asOwner<T>(client: PoolClient, name: string, work: () => Promise<T>): Promise<T> {
    await client.query(`SET ROLE ${quoted(name)}`);
    try {
      return await work();
    } finally {
      await client.query('RESET ROLE');
    }
  }

  private async withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      return await work(client);
    } catch (error) {
      // A connection whose RESET ROLE may not have run never goes back to the pool.
      broken = true;
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

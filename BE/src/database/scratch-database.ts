import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { DatabaseSettings, dataSourceOptions, sslOptions } from './database.options';

/** A new, empty database on the configured server, with a data source already connected to it. */
export interface ScratchDatabase {
  name: string;
  dataSource: DataSource;
  /** Disconnects and drops the database. */
  drop(): Promise<void>;
}

const PREFIX = /^[a-z][a-z0-9_]{0,40}$/;

/** A connection to the server's maintenance database, from which databases are created and dropped. */
function adminDataSource(settings: DatabaseSettings): DataSource {
  return new DataSource({
    type: 'postgres',
    host: settings.host,
    port: settings.port,
    username: settings.username,
    password: settings.password,
    database: 'postgres',
    ssl: sslOptions(settings),
  });
}

/**
 * Creates `<prefix>_<random>` on the server that `settings` points to, and
 * connects to it with the backend's options (entities, migrations, naming).
 * The database starts empty: no migration has run. Used by the drift check
 * (`npm run migration:check`) and the L2 tests, so neither ever touches the
 * configured database itself. Needs the right to create databases.
 */
export async function createScratchDatabase(settings: DatabaseSettings, prefix: string): Promise<ScratchDatabase> {
  if (!PREFIX.test(prefix)) throw new Error(`Invalid scratch database prefix "${prefix}"`);
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const admin = adminDataSource(settings);
  await admin.initialize();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.destroy();
  }

  const dataSource = new DataSource(dataSourceOptions({ ...settings, name, logging: false }));
  try {
    await dataSource.initialize();
  } catch (error) {
    await dropDatabase(settings, name);
    throw error;
  }
  return {
    name,
    dataSource,
    drop: async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
      await dropDatabase(settings, name);
    },
  };
}

/** Runs `work` in a scratch database, and drops the database whatever happens. */
export async function withScratchDatabase<T>(
  settings: DatabaseSettings,
  prefix: string,
  work: (dataSource: DataSource) => Promise<T>,
): Promise<T> {
  const scratch = await createScratchDatabase(settings, prefix);
  try {
    return await work(scratch.dataSource);
  } finally {
    await scratch.drop();
  }
}

async function dropDatabase(settings: DatabaseSettings, name: string): Promise<void> {
  const admin = adminDataSource(settings);
  await admin.initialize();
  try {
    // FORCE (PostgreSQL 13+) ends connections a failed test may have left open.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.destroy();
  }
}

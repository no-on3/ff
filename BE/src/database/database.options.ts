import { DataSourceOptions } from 'typeorm';
import { DatabaseSettings } from '../config/configuration';
import { MIGRATIONS } from '../migrations';
import { ENTITIES } from './entities';
import { SnakeNamingStrategy } from './naming.strategy';

export { DatabaseSettings };

/** TLS to the database, always verified: against DB_SSL_CA when given, else the system's CAs. */
export function sslOptions(settings: DatabaseSettings): false | { rejectUnauthorized: true; ca?: string } {
  if (!settings.ssl) return false;
  return { rejectUnauthorized: true, ...(settings.ssl.ca ? { ca: settings.ssl.ca } : {}) };
}

/**
 * The one definition of the database connection, shared by the backend
 * (AppModule) and the TypeORM CLI (data-source.ts), so both see the same
 * entities, migrations and naming.
 */
export function dataSourceOptions(settings: DatabaseSettings): DataSourceOptions {
  return {
    type: 'postgres',
    host: settings.host,
    port: settings.port,
    username: settings.username,
    password: settings.password,
    database: settings.name,
    ssl: sslOptions(settings),
    entities: ENTITIES,
    migrations: MIGRATIONS,
    namingStrategy: new SnakeNamingStrategy(),
    // The schema comes only from migrations, in every environment: they run as a
    // separate step (npm run migration:run), and the backend refuses to start
    // while one is pending (main.ts).
    synchronize: false,
    migrationsRun: false,
    // UUID defaults use gen_random_uuid(), built into PostgreSQL 13 and newer.
    // TypeORM must not try to install an extension: managed servers may forbid it.
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    logging: settings.logging,
  };
}

import { Account } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { DataSource, EntityTarget } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import { databaseConfiguration } from '../config/configuration';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { FunctionMetrics } from '../metrics/entities/function-metrics.entity';
import { MIGRATIONS } from '../migrations';
import { backendDataSourceOptions, dataSourceOptions, sslOptions } from './database.options';
import { TypeOrmLogger } from './typeorm-logger';
import { ENTITIES } from './entities';

/** Builds the entity mapping without connecting, so it can be checked offline. */
class OfflineDataSource extends DataSource {
  build(): Promise<void> {
    return this.buildMetadatas();
  }
}

const SNAKE = /^[a-z][a-z0-9_]*$/;

describe('dataSourceOptions', () => {
  const settings = { host: 'db', port: 5432, username: 'ff', password: 'secret', name: 'ff', logging: false, ssl: false as const };

  it("sends TypeORM's lines through the backend's logger in a JSON log, and leaves them to TypeORM's coloured console otherwise", () => {
    // It logs what the setting says: the queries in development, nothing in production.
    expect(backendDataSourceOptions({ ...settings, logging: true }, 'json').logger).toEqual(new TypeOrmLogger(true));
    expect(backendDataSourceOptions(settings, 'json').logger).toEqual(new TypeOrmLogger(false));
    expect(backendDataSourceOptions({ ...settings, logging: true }, 'text')).not.toHaveProperty('logger');
    expect(backendDataSourceOptions(settings, 'json')).toMatchObject({ ...dataSourceOptions(settings), logging: false });
  });

  it.each(['development', 'production', undefined])(
    'never synchronizes the schema or runs migrations by itself (NODE_ENV=%s)',
    (nodeEnv) => {
      const env = nodeEnv ? { NODE_ENV: nodeEnv, DB_PASSWORD: 'not-the-default' } : {};

      expect(dataSourceOptions(databaseConfiguration(env))).toMatchObject({ synchronize: false, migrationsRun: false });
    },
  );

  it('connects without TLS unless DB_SSL is on, and then always verifies the server', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

    expect(dataSourceOptions(settings)).toMatchObject({ ssl: false });
    expect(sslOptions({ ...settings, ssl: {} })).toEqual({ rejectUnauthorized: true });
    expect(sslOptions({ ...settings, ssl: { ca: pem } })).toEqual({ rejectUnauthorized: true, ca: pem });
    expect(dataSourceOptions({ ...settings, ssl: { ca: pem } })).toMatchObject({ ssl: { rejectUnauthorized: true, ca: pem } });
  });

  it('connects with the configured settings', () => {
    expect(dataSourceOptions(settings)).toMatchObject({
      type: 'postgres',
      host: 'db',
      port: 5432,
      username: 'ff',
      password: 'secret',
      database: 'ff',
      logging: false,
    });
  });

  it('registers the entities and migrations from their explicit lists', () => {
    const options = dataSourceOptions(settings);

    expect(options.entities).toBe(ENTITIES);
    expect(options.migrations).toBe(MIGRATIONS);
    expect(ENTITIES).toEqual(expect.arrayContaining([Function, FunctionInvocation, FunctionMetrics]));
  });

  it('defaults UUIDs to gen_random_uuid() and never installs an extension', () => {
    const options = dataSourceOptions(settings);
    const driver = new DataSource(options).driver as PostgresDriver;

    expect(options).toMatchObject({ uuidExtension: 'pgcrypto', installExtensions: false });
    expect(driver.uuidGenerator).toBe('gen_random_uuid()');
  });

  describe('entity mapping', () => {
    let dataSource: OfflineDataSource;

    beforeAll(async () => {
      dataSource = new OfflineDataSource(dataSourceOptions(settings));
      await dataSource.build();
    });

    it('names every table and column in snake_case', () => {
      const names = dataSource.entityMetadatas.flatMap((meta) => [
        meta.tableName,
        ...meta.columns.map((column) => column.databaseName),
      ]);

      expect(names.filter((name) => !SNAKE.test(name))).toEqual([]);
    });

    it('keeps the camelCase property names that the API returns', () => {
      const columns = dataSource.getMetadata(Function).columns.map((c) => [c.propertyName, c.databaseName]);

      expect(columns).toEqual(
        expect.arrayContaining([
          ['accountId', 'account_id'],
          ['minInstances', 'min_instances'],
          ['maxInstances', 'max_instances'],
          ['scaleToZero', 'scale_to_zero'],
          ['createdAt', 'created_at'],
          ['updatedAt', 'updated_at'],
        ]),
      );
    });

    it.each([
      ['FunctionInvocation', FunctionInvocation],
      ['FunctionMetrics', FunctionMetrics],
    ])('%s has one function_id column, shared by the property and the relation', (_name, entity) => {
      const meta = dataSource.getMetadata(entity);
      const columns = meta.columns.filter((c) => /^function_?id$/i.test(c.databaseName));

      expect(columns.map((c) => [c.propertyName, c.databaseName])).toEqual([['functionId', 'function_id']]);
      expect(meta.findRelationWithPropertyPath('function')?.joinColumns.map((c) => c.databaseName)).toEqual([
        'function_id',
      ]);
    });

    it.each<[string, EntityTarget<object>, string, string, string]>([
      ['Function.account', Function, 'accountId', 'account', 'account_id'],
      ['Membership.account', Membership, 'accountId', 'account', 'account_id'],
      ['Membership.user', Membership, 'userId', 'user', 'user_id'],
      ['Account.plan', Account, 'planId', 'plan', 'plan_id'],
    ])('%s: one column, shared by the property and the relation (P-12)', (_name, entity, property, relation, column) => {
      const meta = dataSource.getMetadata(entity);

      expect(meta.columns.filter((c) => c.databaseName === column).map((c) => c.propertyName)).toEqual([property]);
      expect(meta.findRelationWithPropertyPath(relation)?.joinColumns.map((c) => c.databaseName)).toEqual([column]);
    });

    it('stores every timestamp with its time zone', () => {
      const timestamps = dataSource.entityMetadatas
        .flatMap((meta) => meta.columns)
        .filter((c) => c.isCreateDate || c.isUpdateDate || c.type === Date || /^timestamp/.test(String(c.type)));

      expect(timestamps.length).toBeGreaterThanOrEqual(6);
      expect(timestamps.filter((c) => c.type !== 'timestamptz').map((c) => c.propertyPath)).toEqual([]);
    });
  });
});

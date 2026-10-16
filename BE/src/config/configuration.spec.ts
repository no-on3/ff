// Imported through the "@/" alias on purpose: this spec also proves the
// Jest moduleNameMapper matches the tsconfig "paths" mapping.
import configuration from '@/config/configuration';

describe('configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {};
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('falls back to development defaults when no variables are set', () => {
    const config = configuration();

    expect(config.port).toBe(3000);
    expect(config.database).toMatchObject({
      host: 'localhost',
      port: 5432,
      name: 'postgres',
      synchronize: true,
      logging: true,
    });
    expect(config.minio).toMatchObject({ port: 9003, useSSL: false, bucketName: 'functions' });
    expect(config.function).toEqual({
      defaultMemory: 128,
      defaultTimeout: 30,
      maxMemory: 1024,
      maxTimeout: 300,
    });
  });

  it('applies environment overrides and parses numbers and booleans', () => {
    process.env = {
      PORT: '4100',
      DB_HOST: 'db.internal',
      DB_PORT: '6543',
      DB_NAME: 'ff',
      MINIO_PORT: '9100',
      MINIO_USE_SSL: 'true',
      MINIO_BUCKET_NAME: 'artifacts',
    };

    const config = configuration();

    expect(config.port).toBe(4100);
    expect(config.database).toMatchObject({ host: 'db.internal', port: 6543, name: 'ff' });
    expect(config.minio).toMatchObject({ port: 9100, useSSL: true, bucketName: 'artifacts' });
  });

  it('turns schema synchronization and query logging off in production', () => {
    process.env = { NODE_ENV: 'production' };

    const config = configuration();

    expect(config.database.synchronize).toBe(false);
    expect(config.database.logging).toBe(false);
  });
});

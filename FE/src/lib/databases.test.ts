import { describe, expect, it } from 'vitest';
import type { DatabaseMetrics } from '../services/api';
import { DEFAULT_SECRET, databaseNameProblem, formatSize, measuredHours, psqlCommand, storageShare } from './databases';

describe("a database's name, as the API takes it", () => {
  it.each(['orders', 'a', 'shop-2', `a${'b'.repeat(62)}`])('takes %s', (name) => {
    expect(databaseNameProblem(name)).toBeNull();
  });

  it.each(['', 'Orders', '2shop', 'shop--2', 'shop-', 'shop_2', `a${'b'.repeat(63)}`])('refuses %j, saying what a name is', (name) => {
    expect(databaseNameProblem(name)).toBe(
      name === '' ? 'Give the database a name' : '1 to 63 lower-case letters, digits and hyphens, a letter first, no two hyphens in a row and none last, as AWS RDS names its databases',
    );
  });
});

describe("a database's size and storage", () => {
  it('gives MB to a tenth, GB from 1,024 MB on, and a dash when the server could not say', () => {
    expect([formatSize(7_634_423), formatSize(1_073_741_824), formatSize(1_610_612_736), formatSize(0), formatSize(null)]).toEqual(['7.3 MB', '1 GB', '1.5 GB', '0 MB', '–']);
  });

  it("gives the share of the plan's storage it uses, in whole percent, past 100 too", () => {
    expect([
      storageShare({ sizeBytes: 7_634_423, storageLimitMb: 1024 }),
      storageShare({ sizeBytes: 1_181_116_006, storageLimitMb: 1024 }),
      storageShare({ sizeBytes: null, storageLimitMb: 1024 }),
    ]).toEqual([1, 110, null]);
  });
});

describe('connecting', () => {
  it('names the secret DATABASE_URL by default, and quotes the string for psql', () => {
    expect([DEFAULT_SECRET, psqlCommand('postgresql://u:p@db.example.tn:5432/d?sslmode=require')]).toEqual(['DATABASE_URL', 'psql "postgresql://u:p@db.example.tn:5432/d?sslmode=require"']);
  });
});

describe("a database's measured hours", () => {
  const metrics: DatabaseMetrics = {
    period: 3600,
    start: '2026-10-23T08:00:00.000Z',
    end: '2026-10-23T11:00:00.000Z',
    timestamps: ['2026-10-23T08:00:00.000Z', '2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z'],
    metrics: {
      DatabaseConnections: { Maximum: [2, null, 5], Average: [2, null, 5] },
      VolumeBytesUsed: { Maximum: [7_000_000, null, 8_000_000], Average: [7_000_000, null, 8_000_000] },
    },
  };

  it('lists them newest first, an hour without a measure left out, as many as asked', () => {
    expect(measuredHours(metrics)).toEqual([
      { at: '2026-10-23T10:00:00.000Z', connections: 5, sizeBytes: 8_000_000 },
      { at: '2026-10-23T08:00:00.000Z', connections: 2, sizeBytes: 7_000_000 },
    ]);
    expect(measuredHours(metrics, 1)).toHaveLength(1);
  });
});

/**
 * L2: what the account's keys use, written in FF's database as each backend
 * notes it: a row per holder, service, resource and operation, its first day
 * kept and its last moved on, never back, whichever backend's turn comes
 * first. Each run works in a scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { AwsEndpoint } from '../common/aws-endpoint';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { KeyUse } from './key-use.entity';
import { KeyUses } from './key-uses.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '740000000001';
const FUNCTION = '5d1a4c3b-9e8f-4a6b-8c4d-3e2f0b7c6f2e';
const key = { id: 'AKFFAAAAAAAAAAAAAAAA', accountId: ACCOUNT, functionId: FUNCTION };
const at = (day: string) => new Date(`${day}T08:00:00Z`);

run("what the account's keys use, in FF's database (L2)", () => {
  let db: ScratchDatabase;
  /** One backend's notes, then another's. */
  let first: KeyUses;
  let second: KeyUses;
  const rows = () =>
    db.dataSource.query<Array<{ holder: string; resource: string; operation: string; first: string; last: string }>>(
      `SELECT holder, resource, operation, first_day::text AS first, last_day::text AS last FROM key_uses ORDER BY resource, operation`,
    );

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    first = new KeyUses(db.dataSource.getRepository(KeyUse));
    second = new KeyUses(db.dataSource.getRepository(KeyUse));
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("keeps a use's first day and moves its last on, never back, whichever backend writes first", async () => {
    first.note({ key, service: AwsEndpoint.S3, resource: 'photos', operation: 'GetObject' }, at('2026-10-29'));
    await first.flush();
    second.note({ key, service: AwsEndpoint.S3, resource: 'photos', operation: 'GetObject' }, at('2026-10-31'));
    await second.flush();
    // The first backend's next turn, late: a day before the other's.
    first.note({ key, service: AwsEndpoint.S3, resource: 'photos', operation: 'GetObject' }, at('2026-10-30'));
    await first.flush();

    expect(await rows()).toEqual([{ holder: FUNCTION, resource: 'photos', operation: 'GetObject', first: '2026-10-29', last: '2026-10-31' }]);
  });

  it("takes every resource's name as long as AWS lets it be, an e-mail sender's 320 characters, and the account's own as ''", async () => {
    const sender = `${'a'.repeat(64)}@${'b'.repeat(252)}.tn`;
    first.note({ key, service: AwsEndpoint.SESV2, resource: sender, operation: 'SendEmail' }, at('2026-10-31'));
    first.note({ key, service: AwsEndpoint.SQS, resource: '', operation: 'ListQueues' }, at('2026-10-31'));

    expect(await first.flush()).toBe(2);

    expect((await rows()).map((row) => `${row.operation} ${row.resource.length}`)).toEqual(['ListQueues 0', 'SendEmail 320', 'GetObject 6']);
  });
});

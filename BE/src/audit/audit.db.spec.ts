/**
 * L2: the audit log against a real PostgreSQL server (client-readiness plan,
 * P-17), in a scratch database that is dropped after: append-only, and read
 * per account, newest first.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { AuditEntry } from './audit-entry.entity';
import { AuditService } from './audit.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run('the audit log (L2, P-17)', () => {
  let db: ScratchDatabase;
  let audit: AuditService;
  const A = '111111111111';
  const B = '222222222222';
  const refusal = (sql: string) => db.dataSource.query(sql).then(() => 'accepted', (error: Error) => error.message);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    for (const n of [1, 2, 3]) await audit.record({ accountId: A, action: 'function.create', resource: `function:f-${n}` });
    await audit.record({ accountId: B, action: 'api_key.create', resource: 'api_key:k-1' });
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("refuses to change or delete an entry, even to the database's owner, and to empty the table", async () => {
    expect(await refusal(`UPDATE audit_log SET action = 'nothing.happened'`)).toBe('audit_log is append-only: UPDATE refused');
    expect(await refusal(`DELETE FROM audit_log WHERE account_id = '${A}'`)).toBe('audit_log is append-only: DELETE refused');
    expect(await refusal('TRUNCATE audit_log')).toBe('audit_log is append-only: TRUNCATE refused');
    expect(await db.dataSource.getRepository(AuditEntry).count()).toBe(4);
  });

  it("reads an account's entries only, newest first, a page at a time", async () => {
    const first = await audit.list(A, { limit: 2 });
    const second = await audit.list(A, { limit: 2, before: first.next as string });

    expect(first.entries.map((entry) => entry.resource)).toEqual(['function:f-3', 'function:f-2']);
    expect(second.entries.map((entry) => entry.resource)).toEqual(['function:f-1']);
    expect(second.next).toBeNull();
    expect((await audit.list(B, { limit: 50 })).entries.map((entry) => entry.resource)).toEqual(['api_key:k-1']);
  });

  it('keeps the time and the actor of each entry: FF, outside a request', async () => {
    const [entry] = (await audit.list(B, { limit: 1 })).entries;

    expect(entry).toMatchObject({ actor: 'system', actorLabel: 'FF', action: 'api_key.create', ip: null, requestId: null, details: null });
    expect(Date.now() - entry.at.getTime()).toBeLessThan(60_000);
  });
});

/**
 * L2: the operator actions of GET /admin/audit-log (client-readiness plan,
 * P-76) against a real PostgreSQL server, in a scratch database that is
 * dropped after: only operators' entries, each filter, pages, and the export.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run('operator actions (L2, P-76)', () => {
  let db: ScratchDatabase;
  let audit: AuditService;
  /** The entries' resources, in the order listed. */
  const resources = (entries: AuditEntry[]) => entries.map((entry) => entry.resource);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    // Oldest first, so the IDs follow the times: [actor, label, action, account, resource, at].
    const rows: Array<[string, string, string, string | null, string, string]> = [
      ['operator:op-a', 'Amira.Admin@FF.test', 'settings.update', null, 'a1', '2026-10-01T10:00:00Z'],
      ['user:u-1', 'amira.admin@ff.test', 'function.create', '111111111111', 'customer', '2026-10-02T10:00:00Z'],
      ['operator:op-b', 'bob_ops@ff.test', 'account.suspend', '111111111111', 'b1', '2026-10-05T10:00:00Z'],
      ['operator:op-c', 'x%y@ff.test', 'account.reject', '333333333333', 'c1', '2026-10-06T10:00:00Z'],
      ['operator:op-a', 'Amira.Admin@FF.test', 'account.approve', '222222222222', 'a2', '2026-10-31T23:59:59.999Z'],
      ['operator:op-a', 'Amira.Admin@FF.test', 'settings.update', null, 'a3', '2026-11-01T00:00:00Z'],
    ];
    for (const [actor, label, action, account, resource, at] of rows) {
      await db.dataSource.query(
        'INSERT INTO audit_log (actor, actor_label, action, account_id, resource, at, details) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [actor, label, action, account, resource, at, { reason: `why ${resource}` }],
      );
    }
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("lists only operators' actions, newest first, a page at a time", async () => {
    const first = await audit.operatorActions({}, { limit: 3 });
    const second = await audit.operatorActions({}, { limit: 3, before: first.next as string });

    expect(resources(first.entries)).toEqual(['a3', 'a2', 'c1']);
    expect(resources(second.entries)).toEqual(['b1', 'a1']);
    expect(second.next).toBeNull();
  });

  it("filters by part of an operator's e-mail, in any case, taking % and _ as themselves", async () => {
    const by = async (operator: string) => resources((await audit.operatorActions({ operator }, { limit: 50 })).entries);

    expect(await by('amira.ADMIN@')).toEqual(['a3', 'a2', 'a1']); // never the customer with the same address
    expect(await by('%')).toEqual(['c1']);
    expect(await by('_')).toEqual(['b1']);
    expect(await by('nobody')).toEqual([]);
  });

  it('filters by account and by action', async () => {
    expect(resources((await audit.operatorActions({ accountId: '111111111111' }, { limit: 50 })).entries)).toEqual(['b1']);
    expect(resources((await audit.operatorActions({ action: 'settings.update' }, { limit: 50 })).entries)).toEqual(['a3', 'a1']);
  });

  it('filters by time: from included, to excluded', async () => {
    const october = await audit.operatorActions(
      { from: new Date('2026-10-01T10:00:00Z'), to: new Date('2026-11-01T00:00:00Z') },
      { limit: 50 },
    );

    expect(resources(october.entries)).toEqual(['a2', 'c1', 'b1', 'a1']);
  });

  it('exports the newest up to the cap, and says when there were more', async () => {
    await expect(audit.operatorActionsForExport({}, 2)).resolves.toMatchObject({ truncated: true, entries: [{ resource: 'a3' }, { resource: 'a2' }] });
    const all = await audit.operatorActionsForExport({ operator: 'amira' }, 10);
    expect([resources(all.entries), all.truncated]).toEqual([['a3', 'a2', 'a1'], false]);
  });
});

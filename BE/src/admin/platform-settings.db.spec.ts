/**
 * L2: the platform's settings against a real PostgreSQL server (client-
 * readiness plan, P-70, D12), in a scratch database that is dropped after:
 * defaults until changed, each change in the audit log with the operator, its
 * reason and what it replaced, and two operators' changes one after the other.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException } from '@nestjs/common';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { PlatformSetting } from './platform-setting.entity';
import { DEFAULT_SETTINGS } from './platform-settings';
import { PlatformSettingsService } from './platform-settings.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const OPERATOR = { id: 'operator:kc-op-1', label: 'operator@ff.test' };

run('the platform settings (L2, P-70)', () => {
  let db: ScratchDatabase;
  let settings: PlatformSettingsService;
  let audit: AuditService;
  const entries = () => db.dataSource.getRepository(AuditEntry).find({ where: { action: 'settings.update' }, order: { id: 'ASC' } });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    audit = new AuditService(db.dataSource.getRepository(AuditEntry));
    // As the request context would name the operator: the audit service takes the actor from it.
    const record = audit.record.bind(audit);
    jest.spyOn(audit, 'record').mockImplementation((event, manager) => record({ actor: OPERATOR, ...event }, manager));
    settings = new PlatformSettingsService(db.dataSource.getRepository(PlatformSetting), audit);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.dataSource.query('DELETE FROM platform_settings');
  });

  it('are their defaults until changed: the table starts empty', async () => {
    await expect(settings.get()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(await db.dataSource.query('SELECT count(*)::int AS n FROM platform_settings')).toEqual([{ n: 0 }]);
  });

  it('change, with the operator, the reason, and what each change replaced in the audit log', async () => {
    const before = (await entries()).length;

    const after = await settings.update({ gracePeriodHours: 48, lowBalancePercents: [30, 0] }, 'Pilot customers asked for more time');

    expect(after).toEqual({ ...DEFAULT_SETTINGS, gracePeriodHours: 48, lowBalancePercents: [30, 0] });
    await expect(settings.get()).resolves.toEqual(after);
    const [entry] = (await entries()).slice(before);
    expect(entry).toMatchObject({
      accountId: null,
      actor: 'operator:kc-op-1',
      actorLabel: 'operator@ff.test',
      resource: 'settings',
      details: {
        reason: 'Pilot customers asked for more time',
        changes: { gracePeriodHours: { from: 24, to: 48 }, lowBalancePercents: { from: [50, 20, 0], to: [30, 0] } },
      },
    });
  });

  it('write nothing for a change to the values already set', async () => {
    await settings.update({ gracePeriodHours: 48 }, 'first');
    const before = (await entries()).length;

    await settings.update({ gracePeriodHours: 48, billingShadowMode: true }, 'again');

    expect((await entries()).length).toBe(before);
  });

  it('refuse a change that does not fit, naming the setting, and change nothing', async () => {
    await expect(settings.update({ gracePeriodHours: -1, negativeBuffer: '1' }, 'oops')).rejects.toEqual(
      new BadRequestException([
        'negativeBuffer: must be an amount in TND with three decimals, such as 5.000',
        'gracePeriodHours: Too small: expected number to be >=0',
      ]),
    );
    await expect(settings.get()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('stop on a stored value that does not fit, naming it; a setting no longer known is left alone', async () => {
    await db.dataSource.query(`INSERT INTO platform_settings VALUES ('retiredSetting', '1'), ('invoiceReminderDay', '40')`);

    await expect(settings.get()).rejects.toThrow('The platform settings are invalid: invoiceReminderDay: Too big: expected number to be <=28');
    await db.dataSource.query(`DELETE FROM platform_settings WHERE key = 'invoiceReminderDay'`);
    await expect(settings.get()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('change nothing when the audit entry cannot be written: they are one transaction', async () => {
    await db.dataSource.query(`
      CREATE FUNCTION refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the audit log is unavailable'; END $$;
      CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_audit();`);
    try {
      await expect(settings.update({ gracePeriodHours: 96 }, 'no trace, no change')).rejects.toThrow('the audit log is unavailable');
    } finally {
      await db.dataSource.query('DROP TRIGGER refuse_audit ON audit_log; DROP FUNCTION refuse_audit();');
    }
    await expect(settings.get()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("take two operators' changes to one setting one after the other: each entry says what it replaced", async () => {
    // Each write now takes 200 ms, so changes that didn't wait for each other would both replace 24.
    await db.dataSource.query(`
      CREATE FUNCTION slow_setting() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER slow_setting BEFORE INSERT OR UPDATE ON platform_settings FOR EACH ROW EXECUTE FUNCTION slow_setting();`);
    const before = (await entries()).length;
    try {
      await Promise.all([settings.update({ gracePeriodHours: 48 }, 'one'), settings.update({ gracePeriodHours: 72 }, 'two')]);
    } finally {
      await db.dataSource.query('DROP TRIGGER slow_setting ON platform_settings; DROP FUNCTION slow_setting();');
    }

    const changes = (await entries()).slice(before).map((entry) => (entry.details as { changes: { gracePeriodHours: unknown } }).changes.gracePeriodHours);
    const last = (await settings.get()).gracePeriodHours;
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ from: 24 });
    expect(changes[1]).toEqual({ from: (changes[0] as { to: number }).to, to: last });
  });
});

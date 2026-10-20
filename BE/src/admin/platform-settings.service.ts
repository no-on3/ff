import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isDeepStrictEqual } from 'node:util';
import { EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PlatformSetting } from './platform-setting.entity';
import { DEFAULT_SETTINGS, PlatformSettings, SETTING_KEYS, platformSettingsSchema, settingProblems } from './platform-settings';

/** The platform's settings (P-70, D12): read by the tasks that use them, changed by operators with a reason. */
@Injectable()
export class PlatformSettingsService {
  constructor(
    @InjectRepository(PlatformSetting) private readonly rows: Repository<PlatformSetting>,
    private readonly audit: AuditService,
  ) {}

  /** Every setting: its stored value, else its default. A stored value that doesn't fit stops the request, naming it. */
  get(): Promise<PlatformSettings> {
    return this.read(this.rows.manager);
  }

  /**
   * Changes some settings, for the operator's reason, in one transaction with
   * the audit entry that says what changed, from what to what. Changes are
   * made one at a time, so each entry's "from" is what it replaced. A change
   * to the values already set writes nothing.
   */
  async update(changes: Record<string, unknown>, reason: string): Promise<PlatformSettings> {
    const parsed = platformSettingsSchema.partial().safeParse(changes);
    if (!parsed.success) throw new BadRequestException(settingProblems(parsed.error));
    return this.rows.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext('platform_settings'))`);
      const before = await this.read(manager);
      const after: PlatformSettings = { ...before, ...parsed.data };
      const changed = SETTING_KEYS.filter((key) => !isDeepStrictEqual(before[key], after[key]));
      if (changed.length === 0) return before;
      for (const key of changed) await manager.upsert(PlatformSetting, { key, value: after[key] }, ['key']);
      await this.audit.record(
        {
          accountId: null,
          action: 'settings.update',
          resource: 'settings',
          details: { reason, changes: Object.fromEntries(changed.map((key) => [key, { from: before[key], to: after[key] }])) },
        },
        manager,
      );
      return after;
    });
  }

  private async read(manager: EntityManager): Promise<PlatformSettings> {
    const stored = new Map((await manager.find(PlatformSetting)).map((row) => [row.key, row.value]));
    // A key no longer known (a setting removed since) is left alone.
    const values = Object.fromEntries(SETTING_KEYS.map((key) => [key, stored.has(key) ? stored.get(key) : DEFAULT_SETTINGS[key]]));
    const parsed = platformSettingsSchema.safeParse(values);
    if (!parsed.success) throw new Error(`The platform settings are invalid: ${settingProblems(parsed.error).join('; ')}`);
    return parsed.data;
  }
}

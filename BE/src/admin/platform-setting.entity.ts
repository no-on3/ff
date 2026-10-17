import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * One of the platform's settings (P-70, D12): billing and platform values that
 * operators change from the admin dashboard. A setting without a row has its
 * default (platform-settings.ts); the audit log keeps each change, its time
 * and its reason.
 */
@Entity('platform_settings')
export class PlatformSetting {
  @PrimaryColumn({ type: 'text' })
  key: string;

  @Column({ type: 'jsonb' })
  value: unknown;
}

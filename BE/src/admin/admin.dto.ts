import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsString, Length } from 'class-validator';
import { REASON_LENGTH } from './operator';
import { DEFAULT_SETTINGS, PlatformSettings } from './platform-settings';

/** What every admin change carries: why, for the audit log (D12). */
export class AdminChange {
  @ApiProperty({ example: 'Pilot customers asked for a longer grace period', minLength: REASON_LENGTH.min, maxLength: REASON_LENGTH.max })
  @IsString()
  @Length(REASON_LENGTH.min, REASON_LENGTH.max)
  reason: string;
}

/** PUT /admin/settings: the settings to change, any of them. */
export class UpdateSettingsDto extends AdminChange {
  @ApiProperty({ type: 'object', additionalProperties: true, example: { gracePeriodHours: 48 } })
  @IsObject()
  settings: Record<string, unknown>;
}

export class SettingsView {
  @ApiProperty({ type: 'object', additionalProperties: true, example: DEFAULT_SETTINGS })
  settings: PlatformSettings;

  @ApiProperty({ type: 'object', additionalProperties: true, example: DEFAULT_SETTINGS, description: 'What each setting is without a change' })
  defaults: PlatformSettings;
}

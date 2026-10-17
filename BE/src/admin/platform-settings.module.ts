import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { PlatformSetting } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';

/**
 * The platform's settings (P-70, D12), on their own: the admin routes change
 * them, and the tasks that use them read them, such as the hourly rating's
 * shadow mode (P-32), without the admin module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PlatformSetting]), AuditModule],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}

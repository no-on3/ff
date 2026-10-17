import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminSettingsController } from './admin-settings.controller';
import { PlatformSetting } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';

/** The admin dashboard's routes, under /admin, for FF's operators only (P-70, D12). */
@Module({
  imports: [TypeOrmModule.forFeature([PlatformSetting]), AuditModule],
  controllers: [AdminSettingsController, AdminAuditController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class AdminModule {}

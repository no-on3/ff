import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEntry } from './audit-entry.entity';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/** The audit log (P-17), for every module that changes an account. */
@Module({
  imports: [TypeOrmModule.forFeature([AuditEntry])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

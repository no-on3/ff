import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { AuditModule } from '../audit/audit.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansService } from './plans.service';

/** Plans and their limits (D5), for every module that applies them. */
@Module({
  imports: [TypeOrmModule.forFeature([Plan, Account]), OrchestratorModule, AuditModule],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}

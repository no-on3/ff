import { MetricsModule } from '@/metrics/metrics.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MinioClientModule } from '../minio-client/minio-client.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { UsageModule } from '../usage/usage.module';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { FunctionsController } from './functions.controller';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Function, FunctionInvocation, FunctionEnvironment]),
    MinioClientModule,
    OrchestratorModule,
    MetricsModule,
    PlansModule,
    AuditModule,
    UsageModule,
    BillingModule,
    EncryptionModule,
  ],
  controllers: [FunctionsController],
  providers: [FunctionsService, EnvironmentStore],
  exports: [FunctionsService],
})
export class FunctionsModule {}

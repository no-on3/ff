import { MetricsModule } from '@/metrics/metrics.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ObjectStoreModule } from '../object-store/object-store.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { UsageModule } from '../usage/usage.module';
import { PackagesModule } from '../packages/packages.module';
import { StorageModule } from '../storage/storage.module';
import { QueuesModule } from '../queues/queues.module';
import { Account } from '../accounts/entities/account.entity';
import { AsyncInvocationsService } from './async-invocations.service';
import { AsyncInvokeWorker } from './async-invoke.worker';
import { FunctionEventInvokeConfig } from './entities/function-event-invoke-config.entity';
import { EventInvokeConfigController } from './event-invoke-config.controller';
import { EventInvokeConfigService } from './event-invoke-config.service';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionAlias } from './entities/function-alias.entity';
import { FunctionVersion } from './entities/function-version.entity';
import { Schedule } from '../schedules/schedule.entity';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { FunctionsController } from './functions.controller';
import { EnvironmentStore } from './environment.store';
import { FunctionsService } from './functions.service';
import { FunctionAliasesController } from './aliases.controller';
import { FunctionAliasesService } from './aliases.service';
import { FunctionVersionsController } from './versions.controller';
import { FunctionVersionsService } from './versions.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Function, FunctionInvocation, FunctionEnvironment, FunctionEventInvokeConfig, FunctionVersion, FunctionAlias, Account, Schedule]),
    ObjectStoreModule,
    OrchestratorModule,
    MetricsModule,
    PlansModule,
    AuditModule,
    UsageModule,
    BillingModule,
    EncryptionModule,
    // A function names a package, and runs its code image.
    PackagesModule,
    // A function's pods get a key of its own to its account's buckets.
    StorageModule,
    // Its asynchronous calls wait in a queue of its own.
    QueuesModule,
  ],
  controllers: [FunctionsController, EventInvokeConfigController, FunctionVersionsController, FunctionAliasesController],
  providers: [FunctionsService, EnvironmentStore, AsyncInvocationsService, AsyncInvokeWorker, EventInvokeConfigService, FunctionVersionsService, FunctionAliasesService],
  exports: [FunctionsService],
})
export class FunctionsModule {}

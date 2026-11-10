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
import { StacksModule } from '../stacks/stacks.module';
import { StorageModule } from '../storage/storage.module';
import { TagsModule } from '../tags/tags.module';
import { QueuesModule } from '../queues/queues.module';
import { Account } from '../accounts/entities/account.entity';
import { AsyncInvocationsService } from './async-invocations.service';
import { AsyncInvokeWorker } from './async-invoke.worker';
import { FunctionEventInvokeConfig } from './entities/function-event-invoke-config.entity';
import { EventInvokeConfigController } from './event-invoke-config.controller';
import { EventInvokeConfigService } from './event-invoke-config.service';
import { FunctionEnvironment } from './entities/function-environment.entity';
import { FunctionAlias } from './entities/function-alias.entity';
import { FunctionPolicyStatement } from './entities/function-policy-statement.entity';
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
import { FunctionKeyRenewal } from './key-renewal.service';
import { FunctionPoliciesService } from './policies.service';
import { StoppedChanges } from './stopped-changes.service';
import { TracesController } from './traces.controller';
import { TracesService } from './traces.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Function, FunctionInvocation, FunctionEnvironment, FunctionEventInvokeConfig, FunctionVersion, FunctionAlias, FunctionPolicyStatement, Account, Schedule]),
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
    // Its answers say which stack it is in, and its tags.
    StacksModule,
    TagsModule,
  ],
  controllers: [FunctionsController, EventInvokeConfigController, FunctionVersionsController, FunctionAliasesController, TracesController],
  providers: [FunctionsService, EnvironmentStore, AsyncInvocationsService, AsyncInvokeWorker, EventInvokeConfigService, FunctionVersionsService, FunctionAliasesService, FunctionPoliciesService, FunctionKeyRenewal, StoppedChanges, TracesService],
  // Lambda's endpoint reads versions and aliases, queues calls and sets their settings, as FF's API does, and keeps its permissions.
  exports: [FunctionsService, FunctionVersionsService, FunctionAliasesService, FunctionPoliciesService, AsyncInvocationsService, EventInvokeConfigService],
})
export class FunctionsModule {}

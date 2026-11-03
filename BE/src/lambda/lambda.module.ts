import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { FunctionsModule } from '../functions/functions.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PackagesModule } from '../packages/packages.module';
import { PlansModule } from '../plans/plans.module';
import { StorageModule } from '../storage/storage.module';
import { TagsModule } from '../tags/tags.module';
import { LambdaCodeLinks } from './lambda-code-links';
import { LambdaFrontDoor } from './lambda-front-door';
import { LambdaFunctionChanges } from './lambda-function-changes';
import { LambdaFunctionReads } from './lambda-functions';
import { LambdaInvoke } from './lambda-invoke';
import { LambdaOperations } from './lambda-operations';
import { LambdaTags } from './lambda-tags';

/**
 * Lambda's endpoint (ADR 0014), which main.ts starts on its port: AWS Lambda's
 * API over FF's own functions, for AWS's tools signed with the account's keys.
 */
@Module({
  imports: [BillingModule, EncryptionModule, FunctionsModule, MetricsModule, PackagesModule, PlansModule, StorageModule, TagsModule],
  providers: [
    LambdaCodeLinks,
    LambdaFunctionReads,
    LambdaFunctionChanges,
    LambdaTags,
    LambdaInvoke,
    // Each group of operations built so far; the others answer that FF doesn't offer them yet.
    {
      provide: LambdaOperations,
      useFactory: (reads: LambdaFunctionReads, changes: LambdaFunctionChanges, tags: LambdaTags, invoke: LambdaInvoke) =>
        new LambdaOperations(reads, changes, tags, invoke),
      inject: [LambdaFunctionReads, LambdaFunctionChanges, LambdaTags, LambdaInvoke],
    },
    LambdaFrontDoor,
  ],
  exports: [LambdaFrontDoor],
})
export class LambdaModule {}

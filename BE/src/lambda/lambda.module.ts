import { Module } from '@nestjs/common';
import { EncryptionModule } from '../encryption/encryption.module';
import { FunctionsModule } from '../functions/functions.module';
import { PackagesModule } from '../packages/packages.module';
import { PlansModule } from '../plans/plans.module';
import { StorageModule } from '../storage/storage.module';
import { LambdaCodeLinks } from './lambda-code-links';
import { LambdaFrontDoor } from './lambda-front-door';
import { LambdaFunctionReads } from './lambda-functions';
import { LambdaOperations } from './lambda-operations';

/**
 * Lambda's endpoint (ADR 0014), which main.ts starts on its port: AWS Lambda's
 * API over FF's own functions, for AWS's tools signed with the account's keys.
 */
@Module({
  imports: [EncryptionModule, FunctionsModule, PackagesModule, PlansModule, StorageModule],
  providers: [
    LambdaCodeLinks,
    LambdaFunctionReads,
    // Each group of operations built so far; the others answer that FF doesn't offer them yet.
    { provide: LambdaOperations, useFactory: (reads: LambdaFunctionReads) => new LambdaOperations(reads), inject: [LambdaFunctionReads] },
    LambdaFrontDoor,
  ],
  exports: [LambdaFrontDoor],
})
export class LambdaModule {}

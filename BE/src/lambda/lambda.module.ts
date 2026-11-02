import { Module } from '@nestjs/common';
import { FunctionsModule } from '../functions/functions.module';
import { PlansModule } from '../plans/plans.module';
import { StorageModule } from '../storage/storage.module';
import { LambdaFrontDoor } from './lambda-front-door';
import { LambdaOperations } from './lambda-operations';

/**
 * Lambda's endpoint (ADR 0014), which main.ts starts on its port: AWS Lambda's
 * API over FF's own functions, for AWS's tools signed with the account's keys.
 */
@Module({
  imports: [FunctionsModule, PlansModule, StorageModule],
  providers: [LambdaOperations, LambdaFrontDoor],
  exports: [LambdaFrontDoor],
})
export class LambdaModule {}

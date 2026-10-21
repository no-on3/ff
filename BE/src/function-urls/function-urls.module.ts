import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { FunctionUrl } from '../functions/entities/function-url.entity';
import { FunctionsModule } from '../functions/functions.module';
import { MetricsModule } from '../metrics/metrics.module';
import { PlansModule } from '../plans/plans.module';
import { FunctionUrlGateway } from './function-url.gateway';
import { FunctionUrlsController } from './function-urls.controller';
import { FunctionUrlsService } from './function-urls.service';

/** Functions' URLs: their configuration, under the API, and the gateway that answers them on a port of its own. */
@Module({
  imports: [TypeOrmModule.forFeature([FunctionUrl, Account]), FunctionsModule, ApiKeysModule, AuditModule, BillingModule, MetricsModule, PlansModule],
  controllers: [FunctionUrlsController],
  providers: [FunctionUrlsService, FunctionUrlGateway],
  exports: [FunctionUrlsService, FunctionUrlGateway],
})
export class FunctionUrlsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { BillingModule } from '../billing/billing.module';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { AuditModule } from '../audit/audit.module';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { MailModule } from '../mail/mail.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { UsageModule } from '../usage/usage.module';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminAuditController } from './admin-audit.controller';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPricesController } from './admin-prices.controller';
import { AdminPricesService } from './admin-prices.service';
import { AdminSettingsController } from './admin-settings.controller';
import { PlatformSetting } from './platform-setting.entity';
import { PlatformSettingsService } from './platform-settings.service';

/** The admin dashboard's routes, under /admin, for FF's operators only (P-70, D12). */
@Module({
  imports: [
    TypeOrmModule.forFeature([PlatformSetting, Account, Membership, Function, FunctionInvocation, PriceBook, Currency]),
    AuditModule,
    BillingModule,
    MailModule,
    OrchestratorModule,
    PlansModule,
    UsageModule,
  ],
  controllers: [AdminSettingsController, AdminAuditController, AdminAccountsController, AdminPlansController, AdminPricesController],
  providers: [PlatformSettingsService, AdminAccountsService, AdminPricesService],
  exports: [PlatformSettingsService],
})
export class AdminModule {}

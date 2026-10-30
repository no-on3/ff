import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { BillingModule } from '../billing/billing.module';
import { Currency } from '../billing/currency.entity';
import { PriceBook } from '../billing/price-book.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { AuditModule } from '../audit/audit.module';
import { CachesModule } from '../caches/caches.module';
import { DatabasesModule } from '../databases/databases.module';
import { EmailModule } from '../email/email.module';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { Schedule } from '../schedules/schedule.entity';
import { FunctionsModule } from '../functions/functions.module';
import { FunctionUrlsModule } from '../function-urls/function-urls.module';
import { MailModule } from '../mail/mail.module';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { PlansModule } from '../plans/plans.module';
import { UsageModule } from '../usage/usage.module';
import { AdminAccountsController } from './admin-accounts.controller';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminAuditController } from './admin-audit.controller';
import { AdminCreditsService } from './admin-credits.service';
import { AdminEmailController } from './admin-email.controller';
import { AdminEmailService } from './admin-email.service';
import { AdminInvoicesController } from './admin-invoices.controller';
import { AdminPaymentsController, certificateBody } from './admin-payments.controller';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPricesController } from './admin-prices.controller';
import { AdminPricesService } from './admin-prices.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminSupportController } from './admin-support.controller';
import { AdminSupportService } from './admin-support.service';
import { PlatformSettingsModule } from './platform-settings.module';
import { StorageModule } from '../storage/storage.module';
import { QueuesModule } from '../queues/queues.module';

/** The admin dashboard's routes, under /admin, for FF's operators only (P-70, D12). */
@Module({
  imports: [
    TypeOrmModule.forFeature([Account, Membership, Function, FunctionInvocation, PriceBook, Currency, Schedule]),
    AuditModule,
    CachesModule,
    DatabasesModule,
    // An account's sending: its sandbox, its switch.
    EmailModule,
    BillingModule,
    FunctionsModule,
    FunctionUrlsModule,
    PlatformSettingsModule,
    MailModule,
    OrchestratorModule,
    PlansModule,
    UsageModule,
    // An account's buckets, and what each holds.
    StorageModule,
    // Its queues, their messages counted.
    QueuesModule,
  ],
  controllers: [
    AdminSettingsController,
    AdminAuditController,
    AdminAccountsController,
    AdminEmailController,
    AdminPlansController,
    AdminPricesController,
    AdminPaymentsController,
    AdminInvoicesController,
    AdminSupportController,
    AdminStatsController,
  ],
  providers: [AdminAccountsService, AdminCreditsService, AdminEmailService, AdminPricesService, AdminSupportService, AdminStatsService],
})
export class AdminModule implements NestModule {
  /** A withholding certificate comes as the request's body (P-35). */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(certificateBody()).forRoutes({ path: 'admin/payments/:id/withholding-certificate', method: RequestMethod.PUT });
  }
}

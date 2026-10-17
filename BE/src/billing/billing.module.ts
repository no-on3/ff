import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformSettingsModule } from '../admin/platform-settings.module';
import { AuditModule } from '../audit/audit.module';
import { MailModule } from '../mail/mail.module';
import { MinioClientModule } from '../minio-client/minio-client.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { CreditService } from './credit.service';
import { Currency } from './currency.entity';
import { HourlyRatingService } from './hourly-rating.service';
import { LedgerEvents } from './ledger/ledger-events';
import { LedgerService } from './ledger/ledger.service';
import { LowBalanceService } from './low-balance.service';
import { PaymentsService } from './payments/payments.service';
import { ProFormasController } from './payments/pro-formas.controller';
import { PriceBook } from './price-book.entity';
import { PricingService } from './pricing.service';

/**
 * Prices and price books (P-30, D8): what usage costs; the ledger (P-31, D9),
 * where money moves; the hourly rating (P-32), which charges usage to it; the
 * balance check and low-balance e-mails (P-33); and bank transfers against
 * pro-formas (P-35). Invoices come with P-36.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PriceBook, Currency]), PlatformSettingsModule, AuditModule, MailModule, MinioClientModule],
  controllers: [BillingController, ProFormasController],
  providers: [PricingService, LedgerService, HourlyRatingService, BillingService, LedgerEvents, CreditService, LowBalanceService, PaymentsService],
  exports: [PricingService, LedgerService, HourlyRatingService, CreditService, PaymentsService],
})
export class BillingModule {}

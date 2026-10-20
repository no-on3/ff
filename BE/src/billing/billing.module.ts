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
import { InvoiceNoticesService } from './invoices/invoice-notices.service';
import { InvoicesController } from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { PaymentsService } from './payments/payments.service';
import { ProFormasController } from './payments/pro-formas.controller';
import { PriceBook } from './price-book.entity';
import { PricingService } from './pricing.service';

/**
 * Prices and price books (P-30, D8): what usage costs; the ledger (P-31, D9),
 * where money moves; the hourly rating (P-32), which charges usage to it; the
 * balance check and low-balance e-mails (P-33); bank transfers against
 * pro-formas (P-35); and the monthly invoices and usage statements (P-36).
 */
@Module({
  imports: [TypeOrmModule.forFeature([PriceBook, Currency]), PlatformSettingsModule, AuditModule, MailModule, MinioClientModule],
  controllers: [BillingController, ProFormasController, InvoicesController],
  providers: [PricingService, LedgerService, HourlyRatingService, BillingService, LedgerEvents, CreditService, LowBalanceService, PaymentsService, InvoicesService, InvoiceNoticesService],
  exports: [PricingService, LedgerService, HourlyRatingService, CreditService, PaymentsService, InvoicesService, BillingService],
})
export class BillingModule {}

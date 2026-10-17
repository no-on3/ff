import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformSettingsModule } from '../admin/platform-settings.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { Currency } from './currency.entity';
import { HourlyRatingService } from './hourly-rating.service';
import { LedgerService } from './ledger/ledger.service';
import { PriceBook } from './price-book.entity';
import { PricingService } from './pricing.service';

/**
 * Prices and price books (P-30, D8): what usage costs; the ledger (P-31, D9),
 * where money moves; and the hourly rating (P-32), which charges usage to it.
 * Payments come with P-34 to P-36.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PriceBook, Currency]), PlatformSettingsModule],
  controllers: [BillingController],
  providers: [PricingService, LedgerService, HourlyRatingService, BillingService],
  exports: [PricingService, LedgerService, HourlyRatingService],
})
export class BillingModule {}

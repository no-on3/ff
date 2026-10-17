import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Currency } from './currency.entity';
import { LedgerService } from './ledger/ledger.service';
import { PriceBook } from './price-book.entity';
import { PricingService } from './pricing.service';

/**
 * Prices and price books (P-30, D8): what usage costs; and the ledger
 * (P-31, D9), where money moves. Rating and payments come with P-32 to P-36.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PriceBook, Currency])],
  providers: [PricingService, LedgerService],
  exports: [PricingService, LedgerService],
})
export class BillingModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Currency } from './currency.entity';
import { PriceBook } from './price-book.entity';
import { PricingService } from './pricing.service';

/** Prices and price books (P-30, D8): what usage costs. The ledger, rating and payments come with P-31 to P-36. */
@Module({
  imports: [TypeOrmModule.forFeature([PriceBook, Currency])],
  providers: [PricingService],
  exports: [PricingService],
})
export class BillingModule {}

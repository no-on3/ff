import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageRecord } from './usage-record.entity';
import { UsageService } from './usage.service';

/** Usage records (P-20, D6). */
@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord])],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}

import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

/** What FF keeps only for a while, and its deletion (P-45). */
@Module({
  providers: [RetentionService],
})
export class RetentionModule {}

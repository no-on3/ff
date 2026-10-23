import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { PlansModule } from '../plans/plans.module';
import { Bucket } from './bucket.entity';
import { BucketsController } from './buckets.controller';
import { BucketsService } from './buckets.service';
import { S3FrontDoor } from './front-door';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StorageKeysController } from './storage-keys.controller';
import { StorageKeysService } from './storage-keys.service';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { StoreBuckets } from './store-buckets';

/**
 * Customers' buckets (ADR 0009): their records and the API that makes them,
 * the keys that reach them, and the S3 front door that answers AWS's SDKs and
 * CLI on a port of its own, counting their requests.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Bucket, StorageKey, StorageRequestCount, Account]), EncryptionModule, AuditModule, PlansModule, BillingModule],
  controllers: [BucketsController, StorageKeysController],
  providers: [StorageDirectory, StorageRequestCountsService, S3FrontDoor, StoreBuckets, BucketsService, StorageKeysService],
  exports: [StorageDirectory, S3FrontDoor, BucketsService],
})
export class StorageModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditModule } from '../audit/audit.module';
import { BillingModule } from '../billing/billing.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlansModule } from '../plans/plans.module';
import { Function } from '../functions/entities/function.entity';
import { Queue } from '../queues/queue.entity';
import { BucketEvents } from './bucket-events';
import { BucketNotificationsService } from './bucket-notifications.service';
import { BucketSamplesService } from './bucket-samples.service';
import { BucketWebsitesService } from './bucket-websites.service';
import { Bucket } from './bucket.entity';
import { BucketsController } from './buckets.controller';
import { BucketsService } from './buckets.service';
import { DeployKeysController } from './deploy-keys.controller';
import { FunctionKeys } from './function-keys.service';
import { S3FrontDoor } from './front-door';
import { SiteTransfer } from './site-transfer.service';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StorageKeysController } from './storage-keys.controller';
import { StorageKeysService } from './storage-keys.service';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';
import { StoreBuckets } from './store-buckets';
import { WebsiteServer } from './website-server';

/**
 * Customers' buckets (ADR 0009): their records and the API that makes them,
 * the keys that reach them, the account's and each function's own, the S3
 * front door that answers AWS's SDKs and CLI on a port of its own, counting
 * their requests, and their hourly measures; their notifications, which the
 * front door publishes for the queues' side to deliver; and their website
 * configurations, which make a bucket a site, and the server that answers sites
 * to browsers on a port of its own, counting what they send.
 */
@Module({
  // A notification's destinations are the account's functions and queues, looked up by their rows.
  imports: [TypeOrmModule.forFeature([Bucket, StorageKey, StorageRequestCount, Account, Function, Queue]), EncryptionModule, AuditModule, PlansModule, BillingModule, NotificationsModule],
  controllers: [BucketsController, StorageKeysController, DeployKeysController],
  providers: [StorageDirectory, StorageRequestCountsService, S3FrontDoor, StoreBuckets, BucketsService, StorageKeysService, FunctionKeys, BucketSamplesService, BucketEvents, BucketNotificationsService, BucketWebsitesService, SiteTransfer, WebsiteServer],
  exports: [StorageDirectory, S3FrontDoor, BucketsService, FunctionKeys, BucketEvents, WebsiteServer],
})
export class StorageModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EncryptionModule } from '../encryption/encryption.module';
import { Bucket } from './bucket.entity';
import { S3FrontDoor } from './front-door';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { StorageRequestCount } from './storage-request-count.entity';
import { StorageRequestCountsService } from './storage-request-counts.service';

/**
 * Customers' buckets (ADR 0009): their records, the keys that reach them, and
 * the S3 front door that answers AWS's SDKs and CLI on a port of its own,
 * counting their requests.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Bucket, StorageKey, StorageRequestCount]), EncryptionModule],
  providers: [StorageDirectory, StorageRequestCountsService, S3FrontDoor],
  exports: [StorageDirectory, S3FrontDoor],
})
export class StorageModule {}

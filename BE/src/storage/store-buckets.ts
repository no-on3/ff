import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The store's settings, as the backend's own objects use them. */
interface StoreSettings {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
}

/**
 * Customers' buckets in the store, by the store's names for them, with FF's
 * own credentials there: made, emptied, deleted. The objects in them come and
 * go through the front door.
 */
@Injectable()
export class StoreBuckets implements OnModuleDestroy {
  private readonly s3: S3Client;

  constructor(config: ConfigService) {
    const store = config.getOrThrow<StoreSettings>('minio');
    this.s3 = new S3Client({
      endpoint: `${store.useSSL ? 'https' : 'http'}://${store.endPoint}:${store.port}`,
      // An S3-compatible store has one host: the bucket goes in the path.
      forcePathStyle: true,
      region: 'us-east-1',
      credentials: { accessKeyId: store.accessKey, secretAccessKey: store.secretKey },
      // Checksums only where S3 requires them: not every S3-compatible store supports the others.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  onModuleDestroy(): void {
    this.s3.destroy();
  }

  async create(storeName: string): Promise<void> {
    await this.s3.send(new CreateBucketCommand({ Bucket: storeName }));
  }

  /** Whether the bucket holds no object and no upload under way. */
  async isEmpty(storeName: string): Promise<boolean> {
    const objects = await this.s3.send(new ListObjectsV2Command({ Bucket: storeName, MaxKeys: 1 }));
    if (objects.KeyCount) return false;
    const uploads = await this.s3.send(new ListMultipartUploadsCommand({ Bucket: storeName, MaxUploads: 1 }));
    return !uploads.Uploads?.length;
  }

  /** Every object deleted, a thousand at a time, and every upload under way aborted; answers how many objects went. */
  async empty(storeName: string): Promise<number> {
    let deleted = 0;
    for (;;) {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: storeName, MaxKeys: 1000 }));
      const keys = (page.Contents ?? []).map(({ Key }) => ({ Key: Key as string }));
      if (keys.length === 0) break;
      const result = await this.s3.send(new DeleteObjectsCommand({ Bucket: storeName, Delete: { Objects: keys, Quiet: true } }));
      if (result.Errors?.length) throw new Error(`The store kept ${result.Errors.length} object(s) of bucket ${storeName}: ${result.Errors[0].Code} ${result.Errors[0].Message}`);
      deleted += keys.length;
    }
    for (;;) {
      const page = await this.s3.send(new ListMultipartUploadsCommand({ Bucket: storeName, MaxUploads: 1000 }));
      const uploads = page.Uploads ?? [];
      if (uploads.length === 0) break;
      for (const upload of uploads) await this.s3.send(new AbortMultipartUploadCommand({ Bucket: storeName, Key: upload.Key, UploadId: upload.UploadId }));
    }
    return deleted;
  }

  /** The bucket itself, empty; nothing for one the store hasn't. */
  async delete(storeName: string): Promise<void> {
    try {
      await this.s3.send(new DeleteBucketCommand({ Bucket: storeName }));
    } catch (error) {
      if ((error as { name?: string }).name !== 'NoSuchBucket') throw error;
    }
  }
}

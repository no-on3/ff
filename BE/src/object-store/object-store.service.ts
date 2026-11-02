import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ConfigService } from '@nestjs/config';
import { describeError } from '../common/describe-error';

/** An object that object storage doesn't have: deleted, or lost with the store, as a restore from the second site brings back. */
export class StoredObjectMissingError extends Error {}

/**
 * FF's own object store, any S3-compatible one (SeaweedFS in development),
 * through the S3 API: a copy of each function's code, functions' packages, the
 * invoices' PDFs and the withholding certificates. Customers' buckets live in
 * the same store, under names of FF's (BE/src/storage).
 */
@Injectable()
export class ObjectStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObjectStoreService.name);
  private readonly s3: S3Client;
  private readonly bucketName: string;

  constructor(private configService: ConfigService) {
    const endPoint = this.configService.get<string>('objectStore.endPoint');
    const port = this.configService.get<number>('objectStore.port');
    const useSSL = this.configService.get<boolean>('objectStore.useSSL');
    const accessKey = this.configService.get<string>('objectStore.accessKey');
    const secretKey = this.configService.get<string>('objectStore.secretKey');
    const bucketName = this.configService.get<string>('objectStore.bucketName');

    if (!endPoint) throw new Error("The object store's endpoint is missing: FF_OBJECT_STORE_ENDPOINT");
    if (!port) throw new Error("The object store's port is missing: FF_OBJECT_STORE_PORT");
    if (useSSL === undefined) throw new Error('Whether the object store uses TLS is missing: FF_OBJECT_STORE_USE_SSL');
    if (!accessKey) throw new Error("The object store's access key is missing: FF_OBJECT_STORE_ACCESS_KEY");
    if (!secretKey) throw new Error("The object store's secret key is missing: FF_OBJECT_STORE_SECRET_KEY");
    if (!bucketName) throw new Error("The object store's bucket is missing: FF_OBJECT_STORE_BUCKET");

    this.s3 = new S3Client({
      endpoint: `${useSSL ? 'https' : 'http'}://${endPoint}:${port}`,
      // The bucket goes in the path, not in the host name: an S3-compatible store has one host.
      forcePathStyle: true,
      // Signatures name a region; S3-compatible stores accept any.
      region: 'us-east-1',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      // Checksums only where S3 requires them: not every S3-compatible store supports the others.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    this.bucketName = bucketName;
  }

  async onModuleInit() {
    try {
      if (!(await this.bucketExists())) await this.s3.send(new CreateBucketCommand({ Bucket: this.bucketName }));
    } catch (error) {
      // Start anyway: storage may come up later, and uploads report their own errors.
      this.logger.error(`Cannot check or create bucket "${this.bucketName}": ${describeS3Error(error)}`);
    }
  }

  onModuleDestroy() {
    this.s3.destroy(); // closes its kept-alive connections
  }

  async uploadCode(path: string, code: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucketName, Key: path, Body: code, ContentType: 'text/plain; charset=utf-8' }),
    );
  }

  async deleteCode(path: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: path }));
  }

  /** A file, streamed from disk: a function's package, up to 50 MB. */
  async putFile(key: string, file: string, size: number, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: contentType }),
    );
  }

  /** An object, streamed to a file: a package, to make its code image. StoredObjectMissingError when storage hasn't it. */
  async getFile(key: string, file: string): Promise<void> {
    const { body } = await this.getObject(key);
    await pipeline(body as Readable, createWriteStream(file, { mode: 0o600 }));
  }

  /** Removes an object; one already gone is no error, as S3 answers. */
  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }

  /** A document kept for the record, such as a withholding certificate (P-35). */
  async putDocument(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: body, ContentType: contentType }));
  }

  /** An object whole, with its type: a document kept, or a package. StoredObjectMissingError when storage hasn't it. */
  async getDocument(key: string): Promise<{ body: Buffer; contentType: string }> {
    const { body, contentType } = await this.getObject(key);
    return { body: Buffer.from(await body.transformToByteArray()), contentType: contentType ?? 'application/octet-stream' };
  }

  /** An object's body and type, as storage answers: StoredObjectMissingError when it hasn't the object. */
  private async getObject(key: string): Promise<{ body: NonNullable<GetObjectCommandOutput['Body']>; contentType?: string }> {
    const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key })).catch((error: unknown) => {
      throw httpStatus(error) === 404 ? new StoredObjectMissingError(`Object storage has no ${key}`) : error;
    });
    if (!object.Body) throw new Error(`The object ${key} has no body`);
    return { body: object.Body, contentType: object.ContentType };
  }

  private async bucketExists(): Promise<boolean> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return true;
    } catch (error) {
      if (httpStatus(error) === 404) return false;
      throw error;
    }
  }
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
}

/** With the HTTP status: an answer to HEAD has no body, so a refused bucket check only says "UnknownError". */
function describeS3Error(error: unknown): string {
  const status = httpStatus(error);
  return status ? `${describeError(error)} (HTTP ${status})` : describeError(error);
}

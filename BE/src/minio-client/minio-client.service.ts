import { CreateBucketCommand, DeleteObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeError } from '../common/describe-error';

/**
 * Keeps a copy of each function's code in object storage, through the S3 API
 * (SeaweedFS in development). It used the MinIO client until P-09 of the
 * client-readiness plan; the class and the MINIO_* variables keep that name.
 */
@Injectable()
export class MinioClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MinioClientService.name);
  private readonly s3: S3Client;
  private readonly bucketName: string;

  constructor(private configService: ConfigService) {
    const endPoint = this.configService.get<string>('minio.endPoint');
    const port = this.configService.get<number>('minio.port');
    const useSSL = this.configService.get<boolean>('minio.useSSL');
    const accessKey = this.configService.get<string>('minio.accessKey');
    const secretKey = this.configService.get<string>('minio.secretKey');
    const bucketName = this.configService.get<string>('minio.bucketName');

    if (!endPoint) throw new Error('Minio endpoint configuration is missing');
    if (!port) throw new Error('Minio port configuration is missing');
    if (useSSL === undefined) throw new Error('Minio useSSL configuration is missing');
    if (!accessKey) throw new Error('Minio access key configuration is missing');
    if (!secretKey) throw new Error('Minio secret key configuration is missing');
    if (!bucketName) throw new Error('Minio bucket name configuration is missing');

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

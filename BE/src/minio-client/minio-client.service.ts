import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class MinioClientService implements OnModuleInit {
  private readonly logger = new Logger(MinioClientService.name);
  private minioClient: Minio.Client;
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

    this.minioClient = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    });

    this.bucketName = bucketName;
  }

  async onModuleInit() {
    try {
      if (!(await this.minioClient.bucketExists(this.bucketName))) {
        await this.minioClient.makeBucket(this.bucketName);
      }
    } catch (error) {
      // Start anyway: storage may come up later, and uploads report their own errors.
      this.logger.error(`Cannot check or create bucket "${this.bucketName}": ${(error as Error).message}`);
    }
  }

  async uploadCode(path: string, code: string): Promise<void> {
    const buffer = Buffer.from(code);
    await this.minioClient.putObject(this.bucketName, path, buffer);
  }

  async deleteCode(path: string): Promise<void> {
    await this.minioClient.removeObject(this.bucketName, path);
  }
}

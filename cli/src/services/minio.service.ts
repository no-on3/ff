import * as Minio from 'minio';

export class MinioService {
  private minioClient: Minio.Client;
  private readonly bucketName: string;

  constructor() {
    const endPoint = process.env.MINIO_ENDPOINT || 'localhost';
    const port = parseInt(process.env.MINIO_PORT || '9003', 10);
    const useSSL = process.env.MINIO_USE_SSL === 'true';
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    const bucketName = process.env.MINIO_BUCKET_NAME;

    if (!accessKey) throw new Error('MINIO_ACCESS_KEY is required');
    if (!secretKey) throw new Error('MINIO_SECRET_KEY is required');
    if (!bucketName) throw new Error('MINIO_BUCKET_NAME is required');

    this.minioClient = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    });

    this.bucketName = bucketName;
  }

  async ensureBucket(): Promise<void> {
    try {
      const bucketExists = await this.minioClient.bucketExists(this.bucketName);
      if (!bucketExists) {
        await this.minioClient.makeBucket(this.bucketName);
      }
    } catch (error) {
      throw new Error(`Failed to ensure bucket exists: ${error}`);
    }
  }

  async uploadFile(path: string, filePath: string): Promise<void> {
    await this.minioClient.fPutObject(this.bucketName, path, filePath);
  }

  async downloadFile(path: string, filePath: string): Promise<void> {
    await this.minioClient.fGetObject(this.bucketName, path, filePath);
  }

  async deleteFile(path: string): Promise<void> {
    await this.minioClient.removeObject(this.bucketName, path);
  }
}

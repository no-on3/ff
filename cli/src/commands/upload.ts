import * as chalk from 'chalk';
import ora from 'ora';
import * as path from 'path';
import { MinioService } from '../services/minio.service';

export async function upload(filePath: string) {
  const spinner = ora('Uploading lambda function...').start();
  const minioService = new MinioService();

  try {
    await minioService.ensureBucket();
    const fileName = path.basename(filePath);
    await minioService.uploadFile(fileName, filePath);
    spinner.succeed(chalk.green(`Lambda function uploaded successfully as ${fileName}`));
  } catch (error) {
    spinner.fail(chalk.red(`Failed to upload lambda function: ${error}`));
    process.exit(1);
  }
}

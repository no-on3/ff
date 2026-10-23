import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WinstonModule } from 'nest-winston';
import { DataSource } from 'typeorm';
import { configureApp } from './app-setup';
import { AppModule } from './app.module';
import { describeError } from './common/describe-error';
import { logFormat, winstonConfig } from './config/winston.config';
import { assertSchemaUpToDate } from './database/schema-check';
import { FunctionUrlGateway } from './function-urls/function-url.gateway';
import { S3FrontDoor } from './storage/front-door';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig(logFormat(process.env))),
  });

  // Migrations are a separate deploy step. Refuse to serve on an outdated schema,
  // before any module starts its timers (onModuleInit runs in listen()).
  await assertSchemaUpToDate(app.get(DataSource));

  const configService = app.get(ConfigService);

  configureApp(app, configService);

  // Start the server
  const port = configService.getOrThrow<number>('port');
  await app.listen(port);
  // Through the logger: in production every line of the log is one JSON object.
  new Logger('Bootstrap').log(`Application is running on: ${await app.getUrl()}`);

  // Then functions' URLs, on a port of their own, which only the edge reaches in a cluster (0: none).
  const urlPort = configService.getOrThrow<number>('functionUrls.port');
  if (urlPort > 0) {
    await app.get(FunctionUrlGateway).listen(urlPort);
    new Logger('Bootstrap').log(`Function URLs are answered on port ${urlPort}, at ${configService.getOrThrow<string>('functionUrls.base')}`);
  }

  // And buckets' S3 front door, on a port of its own too, which the edge and functions reach (0: none).
  const storagePort = configService.getOrThrow<number>('storage.port');
  if (storagePort > 0) {
    await app.get(S3FrontDoor).listen(storagePort);
    new Logger('Bootstrap').log(`Buckets' S3 requests are answered on port ${storagePort}, at ${configService.getOrThrow<string>('storage.base')}`);
  }
}

bootstrap().catch((error: unknown) => {
  // Exit non-zero, so that a deploy or a supervisor sees the failure.
  console.error(`The backend did not start: ${describeError(error)}`);
  process.exit(1);
});

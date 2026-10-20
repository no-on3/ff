import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { WinstonModule } from 'nest-winston';
import { DataSource } from 'typeorm';
import { apiDocument } from './api-document';
import { AppModule } from './app.module';
import { describeError } from './common/describe-error';
import { corsOptions } from './cors';
import { logFormat, winstonConfig } from './config/winston.config';
import { requestContextMiddleware } from './common/request-context';
import { assertSchemaUpToDate } from './database/schema-check';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig(logFormat(process.env))),
  });

  // Migrations are a separate deploy step. Refuse to serve on an outdated schema,
  // before any module starts its timers (onModuleInit runs in listen()).
  await assertSchemaUpToDate(app.get(DataSource));

  const configService = app.get(ConfigService);

  // Global middleware: first, each request's ID, so that every line logged while serving it names it.
  app.use(requestContextMiddleware);
  app.use(helmet());
  app.enableCors(corsOptions(configService.getOrThrow<string[]>('cors.origins')));
  
  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // The OpenAPI document and its viewer, at /api
  SwaggerModule.setup('api', app, apiDocument(app));

  // Start the server
  
  const port = configService.getOrThrow<number>('port');
  await app.listen(port);
  // Through the logger: in production every line of the log is one JSON object.
  new Logger('Bootstrap').log(`Application is running on: ${await app.getUrl()}`);
}

bootstrap().catch((error: unknown) => {
  // Exit non-zero, so that a deploy or a supervisor sees the failure.
  console.error(`The backend did not start: ${describeError(error)}`);
  process.exit(1);
});

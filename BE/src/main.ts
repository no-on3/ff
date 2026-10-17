import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { WinstonModule } from 'nest-winston';
import { DataSource } from 'typeorm';
import { AppModule } from './app.module';
import { describeError } from './common/describe-error';
import { winstonConfig } from './config/winston.config';
import { assertSchemaUpToDate } from './database/schema-check';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig),
  });

  // Migrations are a separate deploy step. Refuse to serve on an outdated schema,
  // before any module starts its timers (onModuleInit runs in listen()).
  await assertSchemaUpToDate(app.get(DataSource));

  const configService = app.get(ConfigService);

  // Global middleware
  app.use(helmet());
  app.enableCors({
    origin: configService.getOrThrow<string[]>('cors.origins'),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    credentials: true,
    maxAge: 3600,
  });
  
  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger setup
  const config = new DocumentBuilder()
    .setTitle('Serverless Platform API')
    .setDescription('The Serverless Platform API description')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // Start the server
  
  const port = configService.getOrThrow<number>('port');
  await app.listen(port);
  console.log(`Application is running on: ${await app.getUrl()}`);
}

bootstrap().catch((error: unknown) => {
  // Exit non-zero, so that a deploy or a supervisor sees the failure.
  console.error(`The backend did not start: ${describeError(error)}`);
  process.exit(1);
});

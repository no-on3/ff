import { Logger, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { WinstonModule } from 'nest-winston';
import { DataSource } from 'typeorm';
import { configureApp } from './app-setup';
import { AppModule } from './app.module';
import { describeError } from './common/describe-error';
import { keepIdleConnections } from './common/http-server';
import { logFormat, winstonConfig } from './config/winston.config';
import { assertSchemaUpToDate } from './database/schema-check';
import { SesFrontDoor } from './email/ses-front-door';
import { FunctionUrlGateway } from './function-urls/function-url.gateway';
import { LambdaFrontDoor } from './lambda/lambda-front-door';
import { SqsFrontDoor } from './queues/sqs-front-door';
import { S3FrontDoor } from './storage/front-door';
import { WebsiteServer } from './storage/website-server';

/**
 * A server of the backend's on a port of its own, beside the API's: the settings it reads its port and its base
 * from, what its log line says it answers, and where, when that isn't its base.
 */
interface PortServer {
  setting: string;
  server: Type<{ listen(port: number): Promise<unknown> }>;
  answers: string;
  at?: (base: string) => string;
}

const PORT_SERVERS: readonly PortServer[] = [
  { setting: 'functionUrls', server: FunctionUrlGateway, answers: 'Function URLs' },
  { setting: 'storage', server: S3FrontDoor, answers: "Buckets' S3 requests" },
  { setting: 'sqs', server: SqsFrontDoor, answers: "Queues' SQS requests" },
  { setting: 'ses', server: SesFrontDoor, answers: "Customers' mail's SES requests" },
  { setting: 'lambda', server: LambdaFrontDoor, answers: "Lambda's requests" },
  { setting: 'website', server: WebsiteServer, answers: "Buckets' sites", at: (base) => `each at <bucket>.${new URL(base).host}` },
];

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: WinstonModule.createLogger(winstonConfig(logFormat(process.env))),
  });

  // Migrations are a separate deploy step. Refuse to serve on an outdated schema,
  // before any module starts its timers (onModuleInit runs in listen()).
  await assertSchemaUpToDate(app.get(DataSource));

  const configService = app.get(ConfigService);

  configureApp(app, configService);

  // Start the server, its idle connections kept longer than the edge's proxy keeps its own.
  const port = configService.getOrThrow<number>('port');
  keepIdleConnections(app.getHttpServer() as Server);
  await app.listen(port);
  // Through the logger: in production every line of the log is one JSON object.
  new Logger('Bootstrap').log(`Application is running on: ${await app.getUrl()}`);

  // Then the servers on ports of their own, each 0 for none: functions' URLs, which only the edge reaches in a
  // cluster; buckets' S3 front door, queues' SQS endpoint, customers' mail's SES endpoint and Lambda's endpoint, which
  // the edge and functions reach; and buckets' sites, which the edge reaches.
  for (const { setting, server, answers, at } of PORT_SERVERS) {
    const serverPort = configService.getOrThrow<number>(`${setting}.port`);
    if (serverPort === 0) continue;
    await app.get(server).listen(serverPort);
    const base = configService.getOrThrow<string>(`${setting}.base`);
    new Logger('Bootstrap').log(`${answers} are answered on port ${serverPort}, ${at ? at(base) : `at ${base}`}`);
  }
}

bootstrap().catch((error: unknown) => {
  // Exit non-zero, so that a deploy or a supervisor sees the failure.
  console.error(`The backend did not start: ${describeError(error)}`);
  process.exit(1);
});

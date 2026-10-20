import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { apiDocument } from './api-document';
import { requestContextMiddleware } from './common/request-context';
import { corsOptions } from './cors';

/**
 * Everything main.ts sets up on the app before it listens, here so that the
 * tests set an app up the same way: the request's context first, the
 * security headers, CORS, the proxies to believe, validation, and the API's
 * documents where the settings say.
 */
export function configureApp(app: INestApplication, config: ConfigService): void {
  // First, each request's ID, so that every line logged while serving it names it.
  app.use(requestContextMiddleware);
  app.use(helmet());
  app.enableCors(corsOptions(config.getOrThrow<string[]>('cors.origins')));
  // Behind the edge proxy, the caller is in X-Forwarded-For, which only the proxies named may set: the audit
  // log's address and the rate limits by address see the caller rather than the proxy.
  const trusted = config.getOrThrow<string[]>('http.trustProxy');
  if (trusted.length > 0) (app as NestExpressApplication).set('trust proxy', trusted);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // The OpenAPI document and its viewer, at /api: off in production unless FF_API_DOCS says otherwise.
  if (config.getOrThrow<boolean>('http.apiDocs')) SwaggerModule.setup('api', app, apiDocument(app));
}

import { INestApplication, PayloadTooLargeException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { RequestHandler, json } from 'express';
import helmet from 'helmet';
import { apiDocument } from './api-document';
import { NoNulPipe } from './common/no-nul.pipe';
import { requestContextMiddleware } from './common/request-context';
import { corsOptions } from './cors';

/**
 * The routes whose JSON bodies may be large: a function's create and update,
 * with its code (900 KiB), and an invocation, with its input (6 MB, as AWS
 * Lambda's). Every other route keeps 100 KB, which its fields' own limits
 * stay within.
 */
const LARGE_BODY_ROUTES = /^(?:POST \/functions|PUT \/functions\/[^/]+|POST \/functions\/[^/]+\/invoke)\/?$/;
export const LARGE_BODY_LIMIT = 7 * 1024 * 1024;
export const BODY_LIMIT = 100 * 1024;

/** JSON bodies, with each route's limit, and a refusal past it that says which limit and why. */
function jsonBodies(): RequestHandler {
  const large = json({ limit: LARGE_BODY_LIMIT });
  const small = json({ limit: BODY_LIMIT });
  return (request, response, next) => {
    const isLarge = LARGE_BODY_ROUTES.test(`${request.method} ${request.path}`);
    (isLarge ? large : small)(request, response, (error?: unknown) => {
      if ((error as { type?: unknown } | undefined)?.type !== 'entity.too.large') return next(error);
      next(
        new PayloadTooLargeException(
          isLarge
            ? "The request's body is over 7 MB (7,340,032 bytes): a function's code may have 900 KiB, an invocation's input 6 MB"
            : "The request's body is over 100 KB (102,400 bytes), this route's limit",
        ),
      );
    });
  };
}

/**
 * Everything main.ts sets up on the app before it listens, here so that the
 * tests set an app up the same way: the request's context first, the
 * security headers, CORS, JSON bodies with each route's limit, the proxies to
 * believe, validation, and the API's documents where the settings say.
 */
export function configureApp(app: INestApplication, config: ConfigService): void {
  // First, each request's ID, so that every line logged while serving it names it.
  app.use(requestContextMiddleware);
  app.use(helmet());
  app.enableCors(corsOptions(config.getOrThrow<string[]>('cors.origins')));
  // After CORS, so that a browser reads the refusal of a body too large; before Nest's own parser, which then finds it read.
  app.use(jsonBodies());
  // Behind the edge proxy, the caller is in X-Forwarded-For, which only the proxies named may set: the audit
  // log's address and the rate limits by address see the caller rather than the proxy.
  const trusted = config.getOrThrow<string[]>('http.trustProxy');
  if (trusted.length > 0) (app as NestExpressApplication).set('trust proxy', trusted);
  // Then text with a NUL character, which PostgreSQL can't store: a 400 rather than the database's 500.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }), new NoNulPipe());
  // The OpenAPI document and its viewer, at /api: off in production unless FF_API_DOCS says otherwise.
  if (config.getOrThrow<boolean>('http.apiDocs')) SwaggerModule.setup('api', app, apiDocument(app));
}

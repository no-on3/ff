import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * What the document says of FF beside its routes: the endpoints AWS's tools call, and what FF keeps of Lambda's
 * without effect, so that no one reads a permission or a role as a promise.
 */
export const API_DESCRIPTION = [
  "FF's API: an account's functions, their versions, aliases, URLs, schedules and settings, its databases, buckets, queues, caches and mail, its stacks, its keys, members, usage and billing.",
  "AWS's tools call FF's own endpoints for Lambda, S3, SQS and SES, signed with the account's access keys (ff keys create).",
  "Lambda's permissions (AddPermission, RemovePermission, GetPolicy) are kept as sent and given back, without effect, as a function's role is:",
  "FF's keys, and a URL's AuthType, decide who calls a function, and the account's own buckets, schedules and queues call it as they are told.",
].join(' ');

/** The OpenAPI document served at /api, built from the controllers' decorators. */
export function apiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Serverless Platform API')
    .setDescription(API_DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}

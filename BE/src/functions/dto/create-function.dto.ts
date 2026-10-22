import { IsString, IsEnum, IsNumber, IsObject, IsOptional, Matches, Min, Max, ValidateBy, ValidateIf } from 'class-validator';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MaxJsonBytes, MaxUtf8Bytes } from '../../common/byte-limits';
import { PLATFORM_LIMITS } from '../../plans/plan-limits';
import { MAX_CODE_BYTES, MAX_METADATA_BYTES } from '../limits';
import { CODE_SHA256, CODE_SHA256_RULE, DEFAULT_HANDLER, MAX_HANDLER_LENGTH, handlerSyntaxProblem } from '../code-package';
import { EventFormat, Runtime } from '../entities/function.entity';
import { IsEnvironment, IsSecrets } from '../environment';

/**
 * AWS Lambda's rule for a function's name, which FF's follow: names address
 * functions, in the CLI as on Lambda. A name given before the rule is kept
 * until the function is renamed, since only a name sent is checked.
 */
export const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A handler as AWS Lambda writes one, whatever the runtime: the service checks it against the function's runtime and package. */
function IsHandler(): PropertyDecorator {
  return ValidateBy({
    name: 'isHandler',
    validator: {
      validate: (value: unknown) => typeof value !== 'string' || handlerSyntaxProblem(value) === undefined,
      defaultMessage: (args) => handlerSyntaxProblem(String(args?.value)) ?? '',
    },
  });
}

export class CreateFunctionDto {
  @ApiProperty({
    description:
      "The function's name: 1 to 64 letters, digits, hyphens or underscores, as on AWS Lambda. Unique within the account and " +
      "compared exactly, case included: another function's answers 409",
    pattern: FUNCTION_NAME.source,
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @Matches(FUNCTION_NAME, { message: "name must be 1 to 64 letters, digits, hyphens or underscores, as an AWS Lambda function's name" })
  name: string;

  @ApiProperty({ enum: Runtime, description: 'Runtime environment for the function' })
  @IsEnum(Runtime)
  runtime: Runtime;

  @ApiPropertyOptional({
    description:
      "The function's code, one file, inline: 3 MiB (3,145,728 bytes) of UTF-8 at most, as AWS Lambda's console takes in its editor; more comes as a package. Required unless " +
      'codeSha256 names a package; sent to a function made from a package, it makes the function inline',
    maxLength: MAX_CODE_BYTES,
  })
  // Required unless a package is named; with one, refused by the service, which says why.
  @ValidateIf((dto: { codeSha256?: unknown; code?: unknown }) => dto.codeSha256 === undefined || dto.code !== undefined)
  @IsString()
  @MaxUtf8Bytes(MAX_CODE_BYTES, "as AWS Lambda's console takes in its editor (3 MiB): more comes as a package")
  code?: string;

  @ApiPropertyOptional({
    description:
      "A package of the account, in place of code: its SHA-256 in base64, as POST /packages answered it. The function runs the " +
      'package (packageType zip), whose files must hold the module its handler names. A change rolls out a new version',
    pattern: CODE_SHA256.source,
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @Matches(CODE_SHA256, { message: `codeSha256 ${CODE_SHA256_RULE}` })
  codeSha256?: string;

  @ApiProperty({
    description: "Memory allocation in MB. The account's plan sets a lower maximum: 1,024 MB on the beta plan",
    minimum: 128,
    maximum: PLATFORM_LIMITS.memoryMb,
  })
  @IsNumber()
  @Min(128)
  @Max(PLATFORM_LIMITS.memoryMb)
  memory: number;

  @ApiProperty({
    description: "Function timeout in seconds. The account's plan sets a lower maximum: 300 s on the beta plan",
    minimum: 1,
    maximum: PLATFORM_LIMITS.timeoutSeconds,
  })
  @IsNumber()
  @Min(1)
  @Max(PLATFORM_LIMITS.timeoutSeconds)
  timeout: number;

  @ApiPropertyOptional({
    default: DEFAULT_HANDLER,
    maxLength: MAX_HANDLER_LENGTH,
    description:
      "What its runtime calls, as AWS Lambda's Handler: <file>.<export> for Node.js, <module>.<function> for Python, the file in a folder " +
      'of the package if need be (src/app.handler). Inline code is the file function.ts or function.py, so its handler is ' +
      'function.<name>. A change rolls out a new version',
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @IsHandler()
  handler?: string;

  @ApiPropertyOptional({
    enum: EventFormat,
    default: EventFormat.LAMBDA,
    description:
      "What the handler gets as its event: lambda, the payload itself, as on AWS Lambda; or wrapped, FF's original { body, headers, " +
      "method, query, path }, which functions made before have. A change rolls out a new version. Function URLs and schedules need lambda",
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsEnum(EventFormat)
  eventFormat?: EventFormat;

  @ApiPropertyOptional({ description: 'Additional metadata: an object, 4 KB at most as JSON', type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  @MaxJsonBytes(MAX_METADATA_BYTES, 'for labels rather than data (4 KB)')
  metadata?: Record<string, unknown>;

  @EnvironmentProperty()
  environment?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      "The function's secrets: variables whose values nobody reads back, not even this API. The function reads them as variables " +
      "(process.env.NAME). The same name rule as variables, and the 4 KB counts them together. Each is kept with when it was set; " +
      'later, GET and PATCH /functions/{id}/secrets list their names and change them. Encrypted at rest.',
    type: 'object',
    additionalProperties: { type: 'string' },
    writeOnly: true,
    example: { DB_PASSWORD: 'correct-horse-battery-staple' },
  })
  @ValidateIf((_dto, value) => value !== undefined)
  @IsSecrets()
  secrets?: Record<string, string>;
}

/**
 * The environment property, as create and update take it: optional, but null
 * is no map, so it is refused rather than taken for "unchanged", as an
 * update's other fields refuse it.
 */
export function EnvironmentProperty(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      description:
        "The function's environment variables, as on AWS Lambda: string values; names of a letter, then letters, digits or underscores, " +
        "two characters at least; the names Lambda and FF's runtimes set are refused; 4 KB at most as JSON text, secrets included. " +
        'An update replaces them all, and rolls out a new version. Whoever reads the function reads them: a value no one may read back is a secret. ' +
        'Encrypted at rest.',
      type: 'object',
      additionalProperties: { type: 'string' },
      example: { TABLE_NAME: 'orders', LOG_LEVEL: 'info' },
    }),
    ValidateIf((_dto, value) => value !== undefined),
    IsEnvironment(),
  );
}

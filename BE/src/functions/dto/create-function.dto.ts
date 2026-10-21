import { IsString, IsEnum, IsNumber, IsOptional, Matches, Min, Max, ValidateIf } from 'class-validator';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PLATFORM_LIMITS } from '../../plans/plan-limits';
import { Runtime } from '../entities/function.entity';
import { IsEnvironment, IsSecrets } from '../environment';

/**
 * AWS Lambda's rule for a function's name, which FF's follow: names address
 * functions, in the CLI as on Lambda. A name given before the rule is kept
 * until the function is renamed, since only a name sent is checked.
 */
export const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

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

  @ApiProperty({ description: 'Function code' })
  @IsString()
  code: string;

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

  @ApiPropertyOptional({ description: 'Additional metadata', type: 'object', additionalProperties: true })
  @IsOptional()
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
 * is no map, so it is refused rather than taken for "unchanged" (an update's
 * other fields are optional in the way that lets null through).
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

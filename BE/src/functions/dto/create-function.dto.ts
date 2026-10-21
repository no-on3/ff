import { IsString, IsEnum, IsNumber, IsOptional, Matches, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PLATFORM_LIMITS } from '../../plans/plan-limits';
import { Runtime } from '../entities/function.entity';

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
}

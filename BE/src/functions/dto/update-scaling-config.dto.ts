import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PLATFORM_LIMITS } from '../../plans/plan-limits';

/** The platform's limit; the account's plan sets a lower one (instancesPerFunction: 10 on the beta plan). */
const MAX_INSTANCES = PLATFORM_LIMITS.instancesPerFunction;

/** PUT /functions/:id/scaling-config: either field, or both. */
export class UpdateScalingConfigDto {
  @ApiPropertyOptional({
    description: "Instances kept running even when idle. Above 0, the function never scales to zero. At most the plan's instancesPerFunction.",
    minimum: 0,
    maximum: MAX_INSTANCES,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INSTANCES)
  minInstances?: number;

  @ApiPropertyOptional({
    description: "The most instances autoscaling may run; each serves one call at a time. At most the plan's instancesPerFunction.",
    minimum: 1,
    maximum: MAX_INSTANCES,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_INSTANCES)
  maxInstances?: number;
}

/** GET and PUT /functions/:id/scaling-config answer this. */
export class ScalingConfig {
  @ApiProperty({ description: 'Instances kept running even when idle' })
  minInstances: number;

  @ApiProperty({ description: 'The most instances autoscaling may run' })
  maxInstances: number;

  @ApiProperty({ description: 'Whether the function scales to zero when idle: exactly when minInstances is 0' })
  scaleToZero: boolean;
}

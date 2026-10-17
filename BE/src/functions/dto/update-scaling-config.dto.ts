import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Until plans exist (client-readiness plan, P-15), every function may have up to this many instances. */
export const MAX_INSTANCES_PER_FUNCTION = 10;

/** PUT /functions/:id/scaling-config: either field, or both. */
export class UpdateScalingConfigDto {
  @ApiPropertyOptional({
    description: 'Instances kept running even when idle. Above 0, the function never scales to zero.',
    minimum: 0,
    maximum: MAX_INSTANCES_PER_FUNCTION,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_INSTANCES_PER_FUNCTION)
  minInstances?: number;

  @ApiPropertyOptional({
    description: 'The most instances autoscaling may run; each serves one call at a time.',
    minimum: 1,
    maximum: MAX_INSTANCES_PER_FUNCTION,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_INSTANCES_PER_FUNCTION)
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

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** The longest page of invocation history one request may ask for. */
export const MAX_PAGE_SIZE = 100;

/** GET /functions/:id/invocations: one page of the history, newest first. */
export class ListInvocationsQuery {
  @ApiPropertyOptional({ description: 'Invocations per page', minimum: 1, maximum: MAX_PAGE_SIZE, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = 10;

  @ApiPropertyOptional({ description: 'Invocations to skip', minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

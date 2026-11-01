import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { CallFilter, EXECUTED_VERSION, QUALIFIER } from '../qualifier';

/** A function's history and its metrics, by what its calls named and what ran them, as CloudWatch's Lambda dimensions. */
export class CallFilterQuery implements CallFilter {
  @ApiPropertyOptional({
    example: 'live',
    description: "The calls that named this alias or this version, or $LATEST for those that named neither: CloudWatch's Resource dimension",
  })
  @IsOptional()
  @Matches(QUALIFIER, { message: 'resource must be $LATEST, a version number or an alias name' })
  resource?: string;

  @ApiPropertyOptional({ example: '2', description: "The calls this version ran, or $LATEST, through an alias or not: CloudWatch's ExecutedVersion dimension" })
  @IsOptional()
  @Matches(EXECUTED_VERSION, { message: 'executedVersion must be $LATEST or a version number' })
  executedVersion?: string;
}

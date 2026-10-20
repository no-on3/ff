import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';
import { AnyJson } from '../../common/no-nul.pipe';

export class InvokeFunctionDto {
  @ApiPropertyOptional({ description: 'The event passed to the handler: a JSON object; {} when missing', type: 'object', additionalProperties: true })
  @IsObject()
  @IsOptional()
  // The function gets it as sent, NUL characters included, as on Lambda; the history stores U+FFFD in their place.
  @AnyJson()
  input?: Record<string, unknown>;
}

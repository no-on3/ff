import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { AnyJson } from '../../common/no-nul.pipe';

export class InvokeFunctionDto {
  @ApiPropertyOptional({
    description:
      'The event the handler gets, any JSON value, as AWS Lambda takes a payload; {} when missing. A function made before ' +
      "functions got Lambda's event (eventFormat wrapped) gets it as event.body",
    oneOf: [{ type: 'object', additionalProperties: true }, { type: 'array', items: {} }, { type: 'string' }, { type: 'number' }, { type: 'boolean' }],
    nullable: true,
  })
  @IsOptional()
  // The function gets it as sent, NUL characters included, as on Lambda; the history stores U+FFFD in their place.
  @AnyJson()
  input?: unknown;
}

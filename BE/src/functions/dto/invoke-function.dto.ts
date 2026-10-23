import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { AnyJson } from '../../common/no-nul.pipe';

/** How a call is made, as AWS Lambda's X-Amz-Invocation-Type names it. */
export enum InvocationType {
  /** Called and waited for: the answer is the function's. */
  REQUEST_RESPONSE = 'RequestResponse',
  /** Kept in the function's queue and run without waiting, retried on failure: the answer is its request ID. */
  EVENT = 'Event',
  /** Checked only: nothing runs. */
  DRY_RUN = 'DryRun',
}

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

  @ApiPropertyOptional({
    enum: InvocationType,
    description: "How the call is made, as Lambda's invocation types; the header X-Amz-Invocation-Type says it too, and wins. RequestResponse when missing",
  })
  @IsOptional()
  @IsEnum(InvocationType)
  invocationType?: InvocationType;
}

/** The answer to an asynchronous call: 202, and its request ID, which each of its attempts keeps. */
export class AsyncInvocationView {
  @ApiProperty({ format: 'uuid', description: "The call's request ID: its attempts' in the history and its log lines, and the answer's x-ff-request-id" })
  requestId: string;
}

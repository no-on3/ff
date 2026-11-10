import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvocationSource, InvocationStatus } from '../entities/function-invocation.entity';

/** What brought a call, beyond its source, as a trace shows it. */
export class InvocationTriggerView {
  @ApiPropertyOptional({ description: 'The schedule whose run it was, by its name' })
  schedule?: string;

  @ApiPropertyOptional({ description: 'The queue whose batch it was, by its name' })
  queue?: string;

  @ApiPropertyOptional({ description: "The batch's message whose trace the call joined, else its first, by its ID" })
  messageId?: string;

  @ApiPropertyOptional({ description: 'The bucket whose notification it was' })
  bucket?: string;

  @ApiPropertyOptional({ format: 'uuid', description: "The asynchronous call whose record it was, as that call's destination: its request ID" })
  recordOf?: string;
}

/** One call of a trace. */
export class TraceCallView {
  @ApiProperty({ format: 'uuid', description: "The invocation's ID, as the function's history names it" })
  id: string;

  @ApiProperty({ format: 'uuid', description: "The request's ID, which its log lines name: an asynchronous call's attempts share their first's" })
  requestId: string;

  @ApiProperty({ description: "Which attempt of its request it was, from 1: an asynchronous call's are counted" })
  attempt: number;

  @ApiProperty({ format: 'uuid' })
  functionId: string;

  @ApiProperty({ description: "The function's name" })
  functionName: string;

  @ApiProperty({ enum: InvocationSource, description: "How it came: FF's API or Lambda's, the function's URL, a schedule, an asynchronous call, or a queue's batch" })
  source: InvocationSource;

  @ApiProperty({ type: InvocationTriggerView, nullable: true, description: 'What brought it, beyond its source; null when its source says all' })
  trigger: InvocationTriggerView | null;

  @ApiProperty({ type: Number, nullable: true, description: 'The version that ran it; null for $LATEST' })
  version: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'The alias the call named; null for none' })
  alias: string | null;

  @ApiProperty({ enum: InvocationStatus })
  status: InvocationStatus;

  @ApiProperty({ description: 'How long it ran, in milliseconds' })
  duration: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}

/** One request's trail: the account's calls in a trace, in time order. */
export class TraceView {
  @ApiProperty({ example: '1-6730a1f2-0123456789abcdef01234567', description: "The trace's ID, in X-Ray's format" })
  traceId: string;

  @ApiProperty({ type: [TraceCallView], description: 'Its calls, oldest first' })
  calls: TraceCallView[];

  @ApiProperty({ description: 'Whether the trace has more calls than these, its first' })
  truncated: boolean;
}

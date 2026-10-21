import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import { FunctionLogsQuery } from '../functions/dto/function-logs.dto';
import { InvocationSource, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { UrlAuthType } from '../functions/entities/function-url.entity';
import { EventFormat } from '../functions/entities/function.entity';
import { AdminAccountSummaryView } from './admin-accounts.dto';
import { AdminChange } from './admin.dto';

/** GET /admin/search: one text, looked for as each kind of thing support is asked about. */
export class AdminSearchQuery {
  @ApiProperty({
    example: 'amira@ff.test',
    description: "An account's ID or name, a member's e-mail, a function's ID or name, or a call's request ID",
    minLength: 1,
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'q must have a character other than a space' })
  q: string;
}

export class AdminFunctionHitView {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'hello' }) name: string;
  @ApiProperty({ example: 'nodejs' }) runtime: string;
  @ApiProperty({ example: 'ACTIVE' }) status: string;
  @ApiProperty({ example: '000000000001' }) accountId: string;
  @ApiProperty({ example: 'Tunis Labs' }) accountName: string;
}

/** A call found by its request ID: from the invocation history, or from its usage record once the history no longer keeps it. */
export class AdminCallHitView {
  @ApiProperty({ format: 'uuid' }) requestId: string;
  @ApiProperty({ format: 'uuid' }) functionId: string;
  @ApiProperty({ example: 'hello', description: "The function's name when it was called" }) functionName: string;
  @ApiProperty({ example: '000000000001' }) accountId: string;
  @ApiProperty({ enum: InvocationStatus }) status: InvocationStatus;
  @ApiProperty() at: Date;
  @ApiProperty({ description: 'Whether the invocation history still has the call; if not, its usage record was found' }) inHistory: boolean;
  @ApiProperty({ description: 'Whether its function still exists' }) functionExists: boolean;
}

export class AdminSearchView {
  @ApiProperty({ type: [AdminAccountSummaryView], description: 'By ID, name or a member\'s e-mail: the newest 10' }) accounts: AdminAccountSummaryView[];
  @ApiProperty({ type: [AdminFunctionHitView], description: 'By ID, or a part of the name: 20 at most' }) functions: AdminFunctionHitView[];
  @ApiProperty({ type: [AdminCallHitView], description: 'By request ID' }) calls: AdminCallHitView[];
}

export class FunctionIdParam {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class InvocationIdParam extends FunctionIdParam {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  invocationId: string;
}

/** A function as support sees it: its settings and state, never its code. */
export class AdminFunctionConfigView {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() runtime: string;
  @ApiProperty({ description: 'MB' }) memory: number;
  @ApiProperty({ description: 'Seconds' }) timeout: number;
  @ApiProperty() minInstances: number;
  @ApiProperty() maxInstances: number;
  @ApiProperty() status: string;
  @ApiProperty({ enum: EventFormat, description: "The event it takes: AWS Lambda's, or FF's original wrapped one" }) eventFormat: EventFormat;
  @ApiProperty({ nullable: true, type: String, description: 'Why its last deploy or update failed' }) error: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

/** A call, without what went in and out: those are the customer's users' data, shown only for a reason. */
export class AdminCallView {
  @ApiProperty({ format: 'uuid', description: 'Its request ID' }) id: string;
  @ApiProperty({ enum: InvocationStatus }) status: InvocationStatus;
  @ApiProperty({ enum: InvocationSource, description: 'What brought it: the API, the function\'s URL, or a schedule' }) source: InvocationSource;
  @ApiProperty({ description: 'Milliseconds' }) duration: number;
  @ApiProperty({ nullable: true, type: Number, description: 'MB' }) memoryUsed: number | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'ValidationError',
    description: "A failed call's error type, without its message, which may hold the customer's users' data",
  })
  errorType: string | null;
}

/** A function's URL as support sees it: its address, and who may call it. */
export class AdminFunctionUrlView {
  @ApiProperty() functionUrl: string;
  @ApiProperty({ enum: UrlAuthType }) authType: UrlAuthType;
  @ApiProperty({ description: 'Whether it has a CORS configuration' }) cors: boolean;
  @ApiProperty() createdAt: Date;
}

export class AdminFunctionPageView {
  @ApiProperty({ type: AdminFunctionConfigView }) function: AdminFunctionConfigView;
  @ApiProperty({ type: AdminFunctionUrlView, nullable: true, description: 'Its public address, if it has one' }) url: AdminFunctionUrlView | null;
  @ApiProperty({ type: [String], description: "Its variables' names, never their values" }) variables: string[];
  @ApiProperty({ type: [String], description: "Its secrets' names, never their values" }) secrets: string[];
  @ApiProperty({ type: AdminAccountSummaryView }) account: AdminAccountSummaryView;
  @ApiProperty({ type: [AdminCallView], description: 'The 20 newest calls' }) recentCalls: AdminCallView[];
  @ApiProperty({ type: [AdminCallView], description: 'The 10 newest that failed' }) recentErrors: AdminCallView[];
}

export class AdminCodeView {
  @ApiProperty() runtime: string;
  @ApiProperty() code: string;
}

/** One call's data: what went in, what came out, and its error, as the history keeps them. */
export class AdminCallDataView extends AdminCallView {
  @ApiProperty({ description: 'The start of its JSON text, as a string, when inputTruncated' }) input: unknown;
  @ApiProperty({ description: 'The start of its JSON text, as a string, when outputTruncated' }) output: unknown;
  @ApiProperty({ nullable: true, type: String }) error: string | null;
  @ApiProperty() inputTruncated: boolean;
  @ApiProperty() outputTruncated: boolean;
  @ApiProperty() errorTruncated: boolean;
}

/** POST /admin/functions/:id/logs: why, and which lines, as the customer's own logs route takes them. */
export class AdminFunctionLogsDto extends IntersectionType(AdminChange, FunctionLogsQuery) {}

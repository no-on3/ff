import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { ServerResponse } from 'node:http';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { booleanQuery } from '../common/boolean-query';
import { Invocation } from '../plans/rate-limits';
import { CreateFunctionDto } from './dto/create-function.dto';
import { FunctionLogsQuery, FunctionLogsStreamQuery, FunctionLogsView } from './dto/function-logs.dto';
import { AsyncInvocationView, InvocationType, InvokeFunctionDto } from './dto/invoke-function.dto';
import { ListFunctionsQuery } from './dto/list-functions.dto';
import { ListInvocationsQuery } from './dto/list-invocations.dto';
import { SecretsView, UpdateSecretsDto } from './dto/secrets.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { ScalingConfig, UpdateScalingConfigDto } from './dto/update-scaling-config.dto';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { sendEvents } from './event-stream';
import { AsyncInvocationsService } from './async-invocations.service';
import { FunctionView, FunctionsService } from './functions.service';

const INVOCATION_TYPES = Object.values(InvocationType) as string[];

/** The call's invocation type: the header's, as Lambda takes it, else the body's, else RequestResponse. */
export function invocationTypeOf(header: string | undefined, body: InvocationType | undefined): InvocationType {
  if (header === undefined) return body ?? InvocationType.REQUEST_RESPONSE;
  if (!INVOCATION_TYPES.includes(header)) throw new BadRequestException(`X-Amz-Invocation-Type must be ${INVOCATION_TYPES.join(', ')}: "${header}" is none of them`);
  return header as InvocationType;
}

/** The name of the function's zip, which any header holds: its own, a character Lambda's rule for names refuses made `_`. */
export const codeFileName = (name: string): string => `${name.replace(/[^A-Za-z0-9_-]/g, '_')}.zip`;

/**
 * Every route acts for the caller's account (D4): without a principal it
 * answers 401, and another account's function answers 404, exactly like one
 * that doesn't exist. The service scopes every query to the account. Viewers
 * only read; deploying and invoking need an active account (P-12).
 */
@ApiTags('functions')
@Controller('functions')
export class FunctionsController {
  constructor(
    private readonly functionsService: FunctionsService,
    private readonly asyncInvocations: AsyncInvocationsService,
  ) {}

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Create a new function',
    description:
      'Answers once an instance runs the code. When it can\'t, the function is saved all the same, as ERROR with the reason, ' +
      "and the error's body names it in `functionId`: fix it with PUT /functions/{id}, or delete it, rather than create it again. " +
      'Code that fails to load is reported as soon as its runtime says so, in a few seconds.',
  })
  @ApiResponse({ status: 201, description: 'Function created successfully', type: Function })
  @ApiResponse({
    status: 400,
    description:
      'The request was refused (validation, the plan), and nothing was saved; or the code failed to load, and `functionId` names the function saved as ERROR',
  })
  @ApiResponse({ status: 409, description: 'Another of the account\'s functions has the name: names are unique within an account. Nothing was saved' })
  async create(@Body() createFunctionDto: CreateFunctionDto, @Principal() principal: Principal): Promise<FunctionView> {
    return this.functionsService.create(principal.accountId, createFunctionDto);
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "List the account's functions, newest first; with name, the one of that name" })
  @ApiResponse({ status: 200, description: 'List of functions', type: [Function] })
  async findAll(@Query() query: ListFunctionsQuery, @Principal() principal: Principal): Promise<Function[]> {
    return this.functionsService.findAll(principal.accountId, query.name);
  }

  @Get(':id')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'Get a function by ID' })
  @ApiResponse({ status: 200, description: "Function details, with its environment variables; never its secrets' values", type: Function })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<FunctionView> {
    return this.functionsService.describe(principal.accountId, id);
  }

  @Get(':id/code')
  @RequireScope('functions:read')
  @ApiOperation({
    summary: "The function's code, as a zip AWS Lambda takes",
    description:
      'A package as it was uploaded; inline code as the one-file package its pods run, `function.ts` or `function.py`. ' +
      'With javascript=true, inline Node.js code as JavaScript, `function.js`, transpiled as FF\'s runtime transpiles it before ' +
      "running it, which Lambda's Node.js runtime loads under the same handler; a package, and Python code, as they are",
  })
  @ApiQuery({ name: 'javascript', required: false, enum: ['true', 'false'] })
  @ApiProduces('application/zip')
  @ApiResponse({ status: 200, description: "The zip, named after the function: a character a function's name may no longer hold as _" })
  @ApiResponse({ status: 400, description: "javascript isn't true or false, or the inline code doesn't transpile, which never loaded on FF either" })
  async code(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('javascript') javascript: string | undefined,
    @Principal() principal: Principal,
  ): Promise<StreamableFile> {
    const { name, zip } = await this.functionsService.code(principal.accountId, id, { javascript: booleanQuery('javascript', javascript) });
    return new StreamableFile(zip, { type: 'application/zip', disposition: `attachment; filename="${codeFileName(name)}"`, length: zip.length });
  }

  @Put(':id')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Update a function' })
  @ApiResponse({ status: 200, description: 'Function updated successfully', type: Function })
  @ApiResponse({
    status: 409,
    description:
      "Another of the account's functions has the new name, and nothing changed. Should another function take it during the " +
      'rollout of a new version, that version stays live and the function keeps its name, which the message says',
  })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateFunctionDto: UpdateFunctionDto,
    @Principal() principal: Principal,
  ): Promise<FunctionView> {
    return this.functionsService.update(principal.accountId, id, updateFunctionDto);
  }

  @Delete(':id')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a function' })
  @ApiResponse({ status: 200, description: 'Function deleted successfully' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<void> {
    await this.functionsService.remove(principal.accountId, id);
  }

  @Post(':id/invoke')
  @Invocation() // the plan's invocation rate, not its rate of changes (D5)
  @RequireScope('functions:invoke')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Invoke a function',
    description:
      "As AWS Lambda's Invoke, its invocation type in the header X-Amz-Invocation-Type or in invocationType: RequestResponse waits for the call; " +
      "Event keeps it in the function's queue and answers 202 with its request ID at once, then runs it, retried twice on the function's " +
      'failure (a minute, then two minutes later), with a backoff when throttled, for six hours at most, each attempt in the history under ' +
      'that request ID; DryRun only checks, and answers 204.',
  })
  @ApiHeader({ name: 'X-Amz-Invocation-Type', required: false, enum: InvocationType })
  @ApiResponse({ status: 201, description: 'Function invoked successfully', type: FunctionInvocation })
  @ApiResponse({ status: 202, description: "Event: the call is kept, and runs without waiting; its attempts are in the function's history", type: AsyncInvocationView })
  @ApiResponse({ status: 204, description: 'DryRun: the call could be made; nothing ran' })
  @ApiResponse({
    status: 413,
    description:
      "The input is over AWS Lambda's limit as JSON, 6 MB for a call waited for, 1 MB for an Event: RequestEntityTooLargeException, as Lambda names it",
  })
  @ApiResponse({ status: 429, description: "Over the plan's invocations per second; or, for an Event, the account's messages hold the plan's limit together" })
  async invoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() invokeFunctionDto: InvokeFunctionDto,
    @Headers('x-amz-invocation-type') invocationType: string | undefined,
    @Principal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<FunctionInvocation | AsyncInvocationView | void> {
    const type = invocationTypeOf(invocationType, invokeFunctionDto.invocationType);
    if (type === InvocationType.EVENT) {
      const queued = await this.asyncInvocations.queue(principal.accountId, id, invokeFunctionDto.input);
      response.status(202);
      return queued;
    }
    if (type === InvocationType.DRY_RUN) {
      await this.asyncInvocations.dryRun(principal.accountId, id, invokeFunctionDto.input);
      response.status(204);
      return;
    }
    return this.functionsService.invoke(principal.accountId, id, invokeFunctionDto.input);
  }

  @Get(':id/invocations')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'Get function invocations, newest first' })
  @ApiResponse({ status: 200, description: 'List of function invocations', type: [FunctionInvocation] })
  async getInvocations(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: ListInvocationsQuery,
    @Principal() principal: Principal,
  ): Promise<{ invocations: FunctionInvocation[]; total: number }> {
    return this.functionsService.getInvocations(principal.accountId, id, page);
  }

  @Get(':id/logs')
  @RequireScope('logs:read')
  @ApiOperation({
    summary: "A page of the function's log lines, oldest first: the newest of the window, each with its instance, stream and call's request ID (P-43)",
    description:
      'Every member reads them, and an API key with logs:read. They come from the log store, which keeps them after their instance is gone, ' +
      "for the plan's log retention. A call's lines run from its START line to its REPORT. The window is start (or sinceSeconds) to end; q and " +
      'requestId narrow it; next leads to the older lines. 503 when the log store is unavailable.',
  })
  @ApiResponse({ status: 200, type: FunctionLogsView })
  @ApiResponse({ status: 503, description: 'The log store is unavailable: try again shortly' })
  logs(@Param('id', ParseUUIDPipe) id: string, @Query() query: FunctionLogsQuery, @Principal() principal: Principal): Promise<FunctionLogsView> {
    return this.functionsService.logs(principal.accountId, id, query);
  }

  @Get(':id/logs/stream')
  @RequireScope('logs:read')
  @ApiOperation({
    summary: "The function's live tail: its lines as Server-Sent Events, as the log store gets them (P-43)",
    description:
      'Every member, and an API key with logs:read. Each line comes as a message event whose data is the line, as in a page, about 5 s after it ' +
      'was written: the store waits for lines that reach it late. q and requestId narrow it. A ping event comes every 15 s; an end event after ' +
      "30 minutes, when the stream closes and the client opens another; an unavailable event if the log store can't start the tail or fails. " +
      "404 for another account's function comes as JSON, before the stream.",
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ status: 200, description: 'The event stream' })
  async logsStream(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: FunctionLogsStreamQuery,
    @Principal() principal: Principal,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const tail = new AbortController();
    // Every check first: another account's function is a JSON 404, before anything of the stream is sent.
    const events = await this.functionsService.liveLogs(principal.accountId, id, query, tail.signal);
    await sendEvents(res, events, () => tail.abort());
  }

  @Get(':id/secrets')
  @RequireScope('functions:read')
  @ApiOperation({
    summary: "The function's secrets: each one's name, and when it was set; never a value",
    description: 'Every member reads them, and an API key with functions:read. Nobody reads a value back, not even this API: the function alone does.',
  })
  @ApiResponse({ status: 200, type: SecretsView })
  listSecrets(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<SecretsView> {
    return this.functionsService.listSecrets(principal.accountId, id);
  }

  @Patch(':id/secrets')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Set secrets, and remove them with null',
    description:
      'The secrets named are set, or removed with null; the others stay. A change rolls out a new version, as a change of variables does, ' +
      'and the answer comes once it is live; a value already set, or a name already gone, changes nothing. Owners and developers, and an ' +
      'API key with functions:write.',
  })
  @ApiResponse({ status: 200, type: SecretsView })
  @ApiResponse({
    status: 400,
    description:
      "A name outside the rule or a variable's, or more than 4 KB with the variables; or the new version didn't start, and the previous one is still live",
  })
  updateSecrets(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSecretsDto, @Principal() principal: Principal): Promise<SecretsView> {
    return this.functionsService.updateSecrets(principal.accountId, id, dto.secrets);
  }

  @Get(':id/scaling-config')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'Get function scaling configuration' })
  @ApiResponse({ status: 200, description: 'Scaling configuration details', type: ScalingConfig })
  async getScalingConfig(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<ScalingConfig> {
    return this.functionsService.scalingConfig(await this.functionsService.findOne(principal.accountId, id));
  }

  @Put(':id/scaling-config')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Change how many instances a function may have' })
  @ApiResponse({ status: 200, description: 'The new scaling configuration', type: ScalingConfig })
  async updateScalingConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateScalingConfigDto: UpdateScalingConfigDto,
    @Principal() principal: Principal,
  ): Promise<ScalingConfig> {
    return this.functionsService.updateScalingConfig(principal.accountId, id, updateScalingConfigDto);
  }
}

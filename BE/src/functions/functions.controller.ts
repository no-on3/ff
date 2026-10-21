import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { Invocation } from '../plans/rate-limits';
import { CreateFunctionDto } from './dto/create-function.dto';
import { FunctionLogsQuery, FunctionLogsStreamQuery, FunctionLogsView } from './dto/function-logs.dto';
import { InvokeFunctionDto } from './dto/invoke-function.dto';
import { ListInvocationsQuery } from './dto/list-invocations.dto';
import { UpdateFunctionDto } from './dto/update-function.dto';
import { ScalingConfig, UpdateScalingConfigDto } from './dto/update-scaling-config.dto';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { Function } from './entities/function.entity';
import { sendEvents } from './event-stream';
import { FunctionsService } from './functions.service';

/**
 * Every route acts for the caller's account (D4): without a principal it
 * answers 401, and another account's function answers 404, exactly like one
 * that doesn't exist. The service scopes every query to the account. Viewers
 * only read; deploying and invoking need an active account (P-12).
 */
@ApiTags('functions')
@Controller('functions')
export class FunctionsController {
  constructor(private readonly functionsService: FunctionsService) {}

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
  async create(@Body() createFunctionDto: CreateFunctionDto, @Principal() principal: Principal): Promise<Function> {
    return this.functionsService.create(principal.accountId, createFunctionDto);
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "List the account's functions" })
  @ApiResponse({ status: 200, description: 'List of functions', type: [Function] })
  async findAll(@Principal() principal: Principal): Promise<Function[]> {
    return this.functionsService.findAll(principal.accountId);
  }

  @Get(':id')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'Get a function by ID' })
  @ApiResponse({ status: 200, description: 'Function details', type: Function })
  async findOne(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<Function> {
    return this.functionsService.findOne(principal.accountId, id);
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
  ): Promise<Function> {
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
  @ApiOperation({ summary: 'Invoke a function' })
  @ApiResponse({ status: 201, description: 'Function invoked successfully', type: FunctionInvocation })
  async invoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() invokeFunctionDto: InvokeFunctionDto,
    @Principal() principal: Principal,
  ): Promise<FunctionInvocation> {
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

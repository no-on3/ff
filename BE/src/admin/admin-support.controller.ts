import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FunctionLogsView } from '../functions/dto/function-logs.dto';
import {
  AdminCallDataView,
  AdminCodeView,
  AdminFunctionLogsDto,
  AdminFunctionPageView,
  AdminSearchQuery,
  AdminSearchView,
  FunctionIdParam,
  InvocationIdParam,
} from './admin-support.dto';
import { AdminSupportService } from './admin-support.service';
import { AdminChange } from './admin.dto';
import { AdminRoutes } from './operator';

const RECORDED = "The reason goes to the account's audit log, where its owners see the look as FF's";

/**
 * Support for FF's operators: one search for what a customer asks about, and a
 * function's page. The customer's data (code, a call's input and output, logs)
 * comes only for a reason, recorded in the customer's audit log; those routes
 * are POSTs, as each records an entry.
 */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin')
export class AdminSupportController {
  constructor(private readonly support: AdminSupportService) {}

  @Get('search')
  @ApiOperation({ summary: "Accounts, functions and calls matching an ID, a name, a member's e-mail or a request ID (operators only)" })
  @ApiResponse({ status: 200, type: AdminSearchView })
  search(@Query() { q }: AdminSearchQuery): Promise<AdminSearchView> {
    return this.support.search(q);
  }

  @Get('functions/:id')
  @ApiOperation({ summary: 'A function: its settings, state and account, its recent calls and failures, without their data (operators only)' })
  @ApiResponse({ status: 200, type: AdminFunctionPageView })
  functionPage(@Param() { id }: FunctionIdParam): Promise<AdminFunctionPageView> {
    return this.support.functionPage(id);
  }

  @Post('functions/:id/code')
  @HttpCode(200)
  @ApiOperation({ summary: `A function's code. ${RECORDED} (operators only)` })
  @ApiResponse({ status: 200, type: AdminCodeView })
  code(@Param() { id }: FunctionIdParam, @Body() { reason }: AdminChange): Promise<AdminCodeView> {
    return this.support.viewCode(id, reason);
  }

  @Post('functions/:id/invocations/:invocationId')
  @HttpCode(200)
  @ApiOperation({ summary: `A call's input, output and error, as the history keeps them. ${RECORDED} (operators only)` })
  @ApiResponse({ status: 200, type: AdminCallDataView })
  call(@Param() { id, invocationId }: InvocationIdParam, @Body() { reason }: AdminChange): Promise<AdminCallDataView> {
    return this.support.viewCall(id, invocationId, reason);
  }

  @Post('functions/:id/logs')
  @HttpCode(200)
  @ApiOperation({ summary: `A page of a function's log lines, asked for as its account asks. ${RECORDED}, with what was asked (operators only)` })
  @ApiResponse({ status: 200, type: FunctionLogsView })
  logs(@Param() { id }: FunctionIdParam, @Body() body: AdminFunctionLogsDto): Promise<FunctionLogsView> {
    const { reason, ...request } = body;
    return this.support.viewLogs(id, reason, request);
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuditPageView, AuditQuery } from '../audit/audit.dto';
import { PlanSummary } from '../plans/plan.dto';
import { PlansService } from '../plans/plans.service';
import { StatusChange } from './account-status-changes';
import { AccountIdParam, AdminAccountPageView, AdminAccountView, AdminAccountsQuery, AdminEgressDto, AdminPlanDto } from './admin-accounts.dto';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminChange } from './admin.dto';
import { AdminRoutes } from './operator';

const OWNERS_SEE = "The account's owners get an e-mail, and see the reason in their audit log";

/**
 * Accounts, for FF's operators (P-71): the approvals queue is the list of
 * pending accounts. Each change takes a reason, which goes to the account's
 * audit log, and answers with the account page.
 */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/accounts')
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Accounts, newest first, searched and filtered; status=pending is the approvals queue (operators only)' })
  @ApiResponse({ status: 200, type: AdminAccountPageView })
  list(@Query() query: AdminAccountsQuery): Promise<AdminAccountPageView> {
    return this.accounts.list({ q: query.q, status: query.status, planId: query.plan }, { limit: query.limit ?? 50, before: query.before });
  }

  @Get(':id')
  @ApiOperation({ summary: "An account's page: owners and members, functions, this month's usage, status history (operators only)" })
  @ApiResponse({ status: 200, type: AdminAccountView })
  detail(@Param() { id }: AccountIdParam): Promise<AdminAccountView> {
    return this.accounts.detail(id);
  }

  @Get(':id/audit-log')
  @ApiOperation({ summary: "An account's whole audit log, newest first, operators named (operators only)" })
  @ApiResponse({ status: 200, type: AuditPageView })
  auditLog(@Param() { id }: AccountIdParam, @Query() query: AuditQuery): Promise<AuditPageView> {
    return this.accounts.auditLog(id, { limit: query.limit ?? 50, before: query.before });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: `Approve a pending account: it may deploy and invoke. ${OWNERS_SEE} (operators only)` })
  @ApiResponse({ status: 200, type: AdminAccountView })
  approve(@Param() { id }: AccountIdParam, @Body() body: AdminChange): Promise<AdminAccountView> {
    return this.change(id, 'approve', body);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: `Reject a pending account. ${OWNERS_SEE} (operators only)` })
  @ApiResponse({ status: 200, type: AdminAccountView })
  reject(@Param() { id }: AccountIdParam, @Body() body: AdminChange): Promise<AdminAccountView> {
    return this.change(id, 'reject', body);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @ApiOperation({ summary: `Suspend an active account: its functions stop, and it can't deploy or invoke. Nothing is deleted. ${OWNERS_SEE} (operators only)` })
  @ApiResponse({ status: 200, type: AdminAccountView })
  suspend(@Param() { id }: AccountIdParam, @Body() body: AdminChange): Promise<AdminAccountView> {
    return this.change(id, 'suspend', body);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @ApiOperation({ summary: `Reactivate a suspended account: warm instances come back. ${OWNERS_SEE} (operators only)` })
  @ApiResponse({ status: 200, type: AdminAccountView })
  reactivate(@Param() { id }: AccountIdParam, @Body() body: AdminChange): Promise<AdminAccountView> {
    return this.change(id, 'reactivate', body);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({ summary: `Close an account, for good: its functions stop. ${OWNERS_SEE} (operators only)` })
  @ApiResponse({ status: 200, type: AdminAccountView })
  close(@Param() { id }: AccountIdParam, @Body() body: AdminChange): Promise<AdminAccountView> {
    return this.change(id, 'close', body);
  }

  @Put(':id/plan')
  @ApiOperation({ summary: "Move the account to another plan; its quota applies at once (operators only)" })
  @ApiResponse({ status: 200, type: AdminAccountView })
  plan(@Param() { id }: AccountIdParam, @Body() body: AdminPlanDto): Promise<AdminAccountView> {
    return this.accounts.changePlan(id, body.planId, body.reason);
  }

  @Put(':id/egress')
  @ApiOperation({ summary: "Whether the account's functions may reach the internet (D5); the cluster follows it from P-62 (operators only)" })
  @ApiResponse({ status: 200, type: AdminAccountView })
  egress(@Param() { id }: AccountIdParam, @Body() body: AdminEgressDto): Promise<AdminAccountView> {
    return this.accounts.setEgress(id, body.internetEgress, body.reason);
  }

  private change(id: string, change: StatusChange, body: AdminChange): Promise<AdminAccountView> {
    return this.accounts.changeStatus(id, change, body.reason);
  }
}

/** The plans an account can be moved to (P-71); P-73 edits them. */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOperation({ summary: 'Every plan, with its limits (operators only)' })
  @ApiResponse({ status: 200, type: [PlanSummary] })
  list(): Promise<PlanSummary[]> {
    return this.plans.list();
  }
}

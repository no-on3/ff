import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService, OPERATOR_ACTOR, OperatorActionFilter } from '../audit/audit.service';
import { csvField, csvLines, wantsCsv } from '../common/csv';
import { TRUNCATED_HEADER } from '../cors';
import { ADMIN_AUDIT_EXPORT_CAP, AdminAuditQuery, OperatorActionPageView, OperatorActionView } from './admin-audit.dto';
import { AdminRoutes } from './operator';

const CSV_COLUMNS = ['at', 'operator_id', 'operator_email', 'action', 'account_id', 'resource', 'reason', 'ip', 'request_id', 'details'];

export function operatorActionView(entry: AuditEntry): OperatorActionView {
  const details = entry.details;
  return {
    id: entry.id,
    at: entry.at,
    operator: { id: entry.actor.slice(OPERATOR_ACTOR.length), email: entry.actorLabel },
    action: entry.action,
    accountId: entry.accountId,
    resource: entry.resource,
    reason: typeof details?.reason === 'string' ? details.reason : null,
    details,
    ip: entry.ip,
    requestId: entry.requestId,
  };
}

/** The actions as CSV: a line each, newest first, the details as JSON. */
export function operatorActionsCsv(views: OperatorActionView[]): string {
  return csvLines([
    CSV_COLUMNS,
    ...views.map((view) => [
      csvField(view.at.toISOString()),
      csvField(view.operator.id),
      csvField(view.operator.email, true),
      csvField(view.action),
      csvField(view.accountId),
      csvField(view.resource, true),
      csvField(view.reason, true),
      csvField(view.ip),
      csvField(view.requestId),
      csvField(view.details ? JSON.stringify(view.details) : null, true),
    ]),
  ]);
}

const filterOf = (query: AdminAuditQuery): OperatorActionFilter => ({
  operator: query.operator?.trim() || undefined,
  accountId: query.accountId,
  action: query.action,
  from: query.from ? new Date(query.from) : undefined,
  to: query.to ? new Date(query.to) : undefined,
});

/** Every operator action (P-76): what FF's operators did, when, to which account, and why. */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/audit-log')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: "Every operator action, newest first, filtered; or the newest 10,000 as CSV, with Accept: text/csv (operators only)",
  })
  @ApiProduces('application/json', 'text/csv')
  @ApiResponse({ status: 200, type: OperatorActionPageView })
  async list(
    @Query() query: AdminAuditQuery,
    @Headers('accept') accept: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OperatorActionPageView | string> {
    const filter = filterOf(query);
    if (wantsCsv(accept)) {
      const { entries, truncated } = await this.audit.operatorActionsForExport(filter, ADMIN_AUDIT_EXPORT_CAP);
      response.setHeader('content-type', 'text/csv; charset=utf-8');
      response.setHeader('content-disposition', `attachment; filename="ff-operator-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      // More matched than the export holds: the console says so, and narrower filters give the rest.
      if (truncated) response.setHeader(TRUNCATED_HEADER, 'true');
      return operatorActionsCsv(entries.map(operatorActionView));
    }
    const page = await this.audit.operatorActions(filter, { limit: query.limit ?? 50, before: query.before });
    return { entries: page.entries.map(operatorActionView), next: page.next };
  }
}

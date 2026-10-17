import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireRole } from '../auth/route-rules';
import { AuditPageView, AuditQuery } from './audit.dto';
import { AuditService } from './audit.service';

/** The account's audit log (P-17): its owners', with a user's token or in development mode; no scope, so no API key. */
@ApiTags('audit-log')
@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireRole('owner')
  @ApiOperation({ summary: 'Who changed what in the account, when and from where: newest first' })
  @ApiResponse({ status: 200, type: AuditPageView })
  async list(@Principal() principal: Principal, @Query() query: AuditQuery): Promise<AuditPageView> {
    return this.audit.list(principal.accountId, { limit: query.limit ?? 50, before: query.before });
  }
}

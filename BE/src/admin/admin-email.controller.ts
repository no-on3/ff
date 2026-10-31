import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AccountIdParam } from './admin-accounts.dto';
import { AdminEmailDto, AdminEmailView } from './admin-email.dto';
import { AdminEmailService } from './admin-email.service';
import { AdminRoutes } from './operator';

/** An account's sending (ADR 0012), for FF's operators: its sandbox, its switch, its enforcement. */
@ApiTags('admin')
@AdminRoutes()
@Controller('admin/accounts')
export class AdminEmailController {
  constructor(private readonly email: AdminEmailService) {}

  @Get(':id/email')
  @ApiOperation({ summary: "An account's sending: its sandbox, its switch, its enforcement, its quotas and what it sent, its identities (operators only)" })
  @ApiResponse({ status: 200, type: AdminEmailView })
  view(@Param() { id }: AccountIdParam): Promise<AdminEmailView> {
    return this.email.view(id);
  }

  @Put(':id/email')
  @ApiOperation({
    summary: "Change an account's sending, with a reason: out of the sandbox, paused or on, its enforcement cleared (operators only)",
    description: "The account's owners get an e-mail, and see the reason in their audit log. The values it has already change nothing.",
  })
  @ApiResponse({ status: 200, type: AdminEmailView })
  @ApiResponse({ status: 400, description: 'No change named, or not one of the three' })
  change(@Param() { id }: AccountIdParam, @Body() body: AdminEmailDto): Promise<AdminEmailView> {
    const { productionAccess, sendingEnabled, enforcementStatus, reason } = body;
    if (productionAccess === undefined && sendingEnabled === undefined && enforcementStatus === undefined) {
      throw new BadRequestException('Name a change: productionAccess, sendingEnabled or enforcementStatus');
    }
    return this.email.change(id, { productionAccess, sendingEnabled, enforcementStatus }, reason);
  }
}

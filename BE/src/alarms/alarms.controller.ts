import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { AlarmDto, AlarmView } from './alarms.dto';
import { AlarmsService } from './alarms.service';

/** The account's alarms, as CloudWatch's: every member reads them; owners and developers change them, in an active account. */
@ApiTags('alarms')
@Controller('alarms')
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  @Get()
  @RequireScope('alarms:read')
  @ApiOperation({ summary: "The account's alarms, each with its state and why" })
  @ApiResponse({ status: 200, type: [AlarmView] })
  list(@Principal() principal: Principal): Promise<AlarmView[]> {
    return this.alarms.list(principal.accountId);
  }

  @Get(':id')
  @RequireScope('alarms:read')
  @ApiOperation({ summary: 'One alarm' })
  @ApiResponse({ status: 200, type: AlarmView })
  get(@Principal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<AlarmView> {
    return this.alarms.get(principal.accountId, id);
  }

  @Post()
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @RequireScope('alarms:write')
  @ApiOperation({ summary: 'An alarm on a metric of a function or of the account, or on its money: at most 50 per account' })
  @ApiResponse({ status: 201, type: AlarmView })
  create(@Principal() principal: Principal, @Body() dto: AlarmDto): Promise<AlarmView> {
    return this.alarms.create(principal.accountId, dto);
  }

  @Put(':id')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @RequireScope('alarms:write')
  @ApiOperation({ summary: 'An alarm, replaced whole; judged again at the next evaluation' })
  @ApiResponse({ status: 200, type: AlarmView })
  update(@Principal() principal: Principal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AlarmDto): Promise<AlarmView> {
    return this.alarms.update(principal.accountId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @RequireScope('alarms:write')
  @ApiOperation({ summary: 'An alarm, deleted' })
  @ApiResponse({ status: 204 })
  async remove(@Principal() principal: Principal, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.alarms.remove(principal.accountId, id);
  }
}

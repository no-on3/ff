import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { EventInvokeConfigView, PutEventInvokeConfigDto } from './dto/event-invoke-config.dto';
import { EventInvokeConfigService } from './event-invoke-config.service';

/**
 * A function's settings for its asynchronous calls, as AWS Lambda's
 * EventInvokeConfig: every member reads them; owners and developers set and
 * delete them, as they change the function. Deleting needs no active account.
 */
@ApiTags('functions')
@Controller('functions/:id/event-invoke-config')
export class EventInvokeConfigController {
  constructor(private readonly configs: EventInvokeConfigService) {}

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's settings for its asynchronous calls: its retries, how long a call is kept, its destinations" })
  @ApiResponse({ status: 200, type: EventInvokeConfigView })
  @ApiResponse({ status: 404, description: "No such function in the account, or it has no settings: its calls follow Lambda's defaults" })
  get(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<EventInvokeConfigView> {
    return this.configs.get(principal.accountId, id);
  }

  @Put()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Set the function's settings for its asynchronous calls",
    description:
      "As AWS Lambda's PutFunctionEventInvokeConfig, they are replaced whole: what is left out goes back to Lambda's default (2 retries, 6 hours, " +
      "no destination). A destination is another function of the account, by its ARN or its name; it gets the call's record, Lambda's, as an asynchronous " +
      'call of its own: onSuccess once the call succeeded, onFailure once its retries are used up or it is too old. Calls waiting already follow the new settings.',
  })
  @ApiResponse({ status: 200, type: EventInvokeConfigView })
  @ApiResponse({ status: 400, description: 'A setting out of range, or a destination that is no function of the account' })
  put(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PutEventInvokeConfigDto, @Principal() principal: Principal): Promise<EventInvokeConfigView> {
    return this.configs.put(principal.accountId, id, dto);
  }

  @Delete()
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "Delete the function's settings for its asynchronous calls: its calls follow Lambda's defaults again" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such function in the account, or it has no settings' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<void> {
    await this.configs.remove(principal.accountId, id);
  }
}

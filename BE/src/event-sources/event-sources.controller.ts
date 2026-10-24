import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CreateEventSourceDto, EventSourceView, UpdateEventSourceDto } from './dto/event-source.dto';
import { EventSourcesService } from './event-sources.service';

/**
 * Functions reading queues of their account, as AWS Lambda's event source
 * mappings for SQS: every member reads them; owners and developers make,
 * change and delete them, as they change the function. Making one needs an
 * active account; deleting one doesn't.
 */
@ApiTags('functions')
@Controller()
export class EventSourcesController {
  constructor(private readonly eventSources: EventSourcesService) {}

  @Get('functions/:id/event-sources')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'The queues the function reads, as Lambda lists its event source mappings' })
  @ApiResponse({ status: 200, type: [EventSourceView] })
  @ApiResponse({ status: 404, description: 'No such function in the account' })
  listForFunction(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<EventSourceView[]> {
    return this.eventSources.listForFunction(principal.accountId, id);
  }

  @Post('functions/:id/event-sources')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Have the function read a queue of the account, as Lambda\'s CreateEventSourceMapping',
    description:
      "FF receives the queue's messages in batches and calls the function with SQS's event, Records[]. A call that succeeds deletes its batch; one " +
      'that fails deletes nothing, and its messages come back after the queue\'s visibility timeout, towards its dead-letter queue. With ' +
      'ReportBatchItemFailures, the answer {"batchItemFailures": [{"itemIdentifier": "<messageId>"}]} keeps those alone. Lambda\'s defaults: 10 ' +
      "messages a batch, no window. The queue's visibility timeout must be at least the function's timeout, as Lambda requires.",
  })
  @ApiResponse({ status: 201, type: EventSourceView })
  @ApiResponse({ status: 400, description: "No queue of the account by that ARN, a visibility timeout under the function's timeout, settings out of range, or the plan's queues a function reads" })
  @ApiResponse({ status: 404, description: 'No such function in the account' })
  @ApiResponse({ status: 409, description: 'The function reads that queue already: its mapping is named' })
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateEventSourceDto, @Principal() principal: Principal): Promise<EventSourceView> {
    return this.eventSources.create(principal.accountId, id, dto);
  }

  @Get('event-sources')
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The account's event source mappings, or those reading one queue, as Lambda's ListEventSourceMappings" })
  @ApiQuery({ name: 'eventSourceArn', required: false, description: "A queue's ARN: the functions that read it" })
  @ApiResponse({ status: 200, type: [EventSourceView] })
  @ApiResponse({ status: 400, description: "eventSourceArn isn't a queue's ARN" })
  list(@Query('eventSourceArn') eventSourceArn: string | undefined, @Principal() principal: Principal): Promise<EventSourceView[]> {
    return this.eventSources.list(principal.accountId, eventSourceArn);
  }

  @Get('event-sources/:uuid')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'An event source mapping, as Lambda\'s GetEventSourceMapping' })
  @ApiResponse({ status: 200, type: EventSourceView })
  @ApiResponse({ status: 404, description: 'No such mapping in the account' })
  get(@Param('uuid', ParseUUIDPipe) uuid: string, @Principal() principal: Principal): Promise<EventSourceView> {
    return this.eventSources.get(principal.accountId, uuid);
  }

  @Patch('event-sources/:uuid')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: "Change an event source mapping, as Lambda's UpdateEventSourceMapping: what is given changes, the rest stays; enabled: false stops its reads" })
  @ApiResponse({ status: 200, type: EventSourceView })
  @ApiResponse({ status: 400, description: 'Settings out of range' })
  @ApiResponse({ status: 404, description: 'No such mapping in the account' })
  update(@Param('uuid', ParseUUIDPipe) uuid: string, @Body() dto: UpdateEventSourceDto, @Principal() principal: Principal): Promise<EventSourceView> {
    return this.eventSources.update(principal.accountId, uuid, dto);
  }

  @Delete('event-sources/:uuid')
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "Delete an event source mapping, as Lambda's DeleteEventSourceMapping: the queue is read no more, and its messages stay" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such mapping in the account' })
  async remove(@Param('uuid', ParseUUIDPipe) uuid: string, @Principal() principal: Principal): Promise<void> {
    await this.eventSources.remove(principal.accountId, uuid);
  }
}

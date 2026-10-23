import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CreateQueueDto, QueueView, ReceiveMessagesDto, ReceivedMessageView, SendMessageDto, SentMessageView, UpdateQueueDto } from './dto/queue.dto';
import { QueuesService } from './queues.service';

/**
 * Customers' queues (ADR 0010) in FF's API, beside the SQS endpoint, which
 * AWS's SDKs and CLI call: every member sees them; owners and developers
 * make, change and delete them, and send and receive messages to debug them.
 * Deleting needs no active account: a suspended account may still delete its
 * data.
 */
@ApiTags('queues')
@Controller('queues')
export class QueuesController {
  constructor(private readonly queues: QueuesService) {}

  @Get()
  @RequireScope('queues:read')
  @ApiOperation({ summary: "The account's queues, each with its messages counted" })
  @ApiResponse({ status: 200, type: [QueueView] })
  list(@Principal() principal: Principal): Promise<QueueView[]> {
    return this.queues.list(principal.accountId);
  }

  @Post()
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Make a queue',
    description: "As SQS's CreateQueue, with SQS's attributes and their defaults: its name the account's own. AWS's SDKs and CLI reach it at its URL with one of the account's access keys (POST /storage-keys).",
  })
  @ApiResponse({ status: 201, type: QueueView })
  @ApiResponse({ status: 400, description: 'An attribute was refused, or the plan allows no more queues' })
  @ApiResponse({ status: 409, description: 'The account has a queue of that name' })
  create(@Body() dto: CreateQueueDto, @Principal() principal: Principal): Promise<QueueView> {
    return this.queues.create(principal, dto);
  }

  @Get(':name')
  @RequireScope('queues:read')
  @ApiOperation({ summary: 'A queue: its URL, ARN, attributes and messages' })
  @ApiResponse({ status: 200, type: QueueView })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  get(@Param('name') name: string, @Principal() principal: Principal): Promise<QueueView> {
    return this.queues.get(principal.accountId, name);
  }

  @Patch(':name')
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "Change a queue's attributes", description: "As SQS's SetQueueAttributes: what is given changes, the rest stays; a redrive policy of null removes it." })
  @ApiResponse({ status: 200, type: QueueView })
  @ApiResponse({ status: 400, description: 'An attribute was refused' })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  update(@Param('name') name: string, @Body() dto: UpdateQueueDto, @Principal() principal: Principal): Promise<QueueView> {
    return this.queues.update(principal, name, dto);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a queue', description: 'With its messages, as SQS deletes one: nothing can bring them back.' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  async remove(@Param('name') name: string, @Principal() principal: Principal): Promise<void> {
    await this.queues.remove(principal, name);
  }

  @Post(':name/purge')
  @HttpCode(204)
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "Delete every message of a queue", description: "As SQS's PurgeQueue: the queue stays." })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  async purge(@Param('name') name: string, @Principal() principal: Principal): Promise<void> {
    await this.queues.purge(principal, name);
  }

  @Post(':name/messages')
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Send a message to a queue',
    description: "As SQS's SendMessage, to debug a queue: checked as there, the account's credit and the plan's room for messages among the checks.",
  })
  @ApiResponse({ status: 201, type: SentMessageView })
  @ApiResponse({ status: 400, description: 'The message was refused' })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  @ApiResponse({ status: 429, description: "The account's messages hold the plan's room for them" })
  send(@Param('name') name: string, @Body() dto: SendMessageDto, @Principal() principal: Principal): Promise<SentMessageView> {
    return this.queues.send(principal, name, dto);
  }

  @Post(':name/receive')
  @HttpCode(200)
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @ApiOperation({
    summary: 'Receive messages from a queue',
    description:
      "As SQS's ReceiveMessage, to debug a queue: each message received is hidden for its visibility timeout and its receive counted, as any receive's, which a redrive policy counts too. With waitTimeSeconds, a long poll.",
  })
  @ApiResponse({ status: 200, type: [ReceivedMessageView] })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  receive(
    @Param('name') name: string,
    @Body() dto: ReceiveMessagesDto,
    @Principal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReceivedMessageView[]> {
    // A long poll ends when its caller goes.
    const gone = new AbortController();
    response.on('close', () => gone.abort());
    return this.queues.receive(principal, name, dto, gone.signal);
  }

  @Delete(':name/messages/:receiptHandle')
  @HttpCode(204)
  @RequireScope('queues:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a message', description: "As SQS's DeleteMessage, by the receipt handle of its last receive: an older one deletes nothing." })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 400, description: 'No receipt handle a receive gave' })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  async deleteMessage(@Param('name') name: string, @Param('receiptHandle') receiptHandle: string, @Principal() principal: Principal): Promise<void> {
    await this.queues.deleteMessage(principal, name, receiptHandle);
  }
}

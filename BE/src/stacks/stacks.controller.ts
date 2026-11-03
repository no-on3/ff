import { Body, Controller, Delete, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { PutStackDto, StackSummary, StackView } from './dto/stack.dto';
import { StacksService } from './stacks.service';

/**
 * An account's stacks (ADR 0016), FF's record of what `ff deploy` made of a
 * SAM template: every member reads them; owners and developers put and
 * forget them. Forgetting needs no active account.
 */
@ApiTags('stacks')
@Controller('stacks')
export class StacksController {
  constructor(private readonly stacks: StacksService) {}

  @Get()
  @RequireScope('stacks:read')
  @ApiOperation({ summary: "The account's stacks, by name, their resources counted" })
  @ApiResponse({ status: 200, type: [StackSummary] })
  list(@Principal() principal: Principal): Promise<StackSummary[]> {
    return this.stacks.list(principal.accountId);
  }

  @Get(':name')
  @RequireScope('stacks:read')
  @ApiOperation({ summary: 'A stack: the parameters it was deployed with, its template\'s SHA-256, and each resource with the FF resource it made' })
  @ApiResponse({ status: 200, type: StackView })
  @ApiResponse({ status: 404, description: 'No such stack in the account' })
  get(@Param('name') name: string, @Principal() principal: Principal): Promise<StackView> {
    return this.stacks.get(principal.accountId, name);
  }

  @Put(':name')
  @RequireScope('stacks:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Put a stack as a deploy left it, whole',
    description:
      "`ff deploy` reads a SAM template, makes its resources through FF's API, then puts the stack: each resource's logical ID, its type and the " +
      "FF resource it made, the parameters' values and the template's SHA-256. Not the template's text, which stays the customer's. Made, or replaced " +
      'whole. A function, a queue or a bucket named must be the account\'s, and in no other of its stacks.',
  })
  @ApiResponse({ status: 200, type: StackView })
  @ApiResponse({
    status: 400,
    description: "A name CloudFormation wouldn't take, a logical ID or an FF resource given twice, a function, a queue or a bucket the account hasn't, or the account's 2,000 stacks",
  })
  @ApiResponse({ status: 409, description: 'A function, a queue or a bucket named is in another of the account\'s stacks: nothing changed' })
  put(@Param('name') name: string, @Body() dto: PutStackDto, @Principal() principal: Principal): Promise<StackView> {
    return this.stacks.put(principal.accountId, name, dto);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequireScope('stacks:write')
  @RequireRole(...WRITERS)
  @ApiOperation({
    summary: 'Forget a stack',
    description: "The stack's record goes; what it made stays, which `ff delete-stack` deletes first, as `sam delete` does.",
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such stack in the account' })
  async remove(@Param('name') name: string, @Principal() principal: Principal): Promise<void> {
    await this.stacks.remove(principal.accountId, name);
  }
}

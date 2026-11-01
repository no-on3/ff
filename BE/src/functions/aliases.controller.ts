import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { FunctionAliasesService } from './aliases.service';
import { CreateAliasDto, FunctionAliasView, UpdateAliasDto } from './dto/aliases.dto';

/**
 * A function's aliases, as AWS Lambda's: every member reads them; owners and
 * developers make, change and delete them, as they change the function. Making
 * and changing one needs an active account; deleting one doesn't.
 */
@ApiTags('functions')
@Controller('functions/:id/aliases')
export class FunctionAliasesController {
  constructor(private readonly aliases: FunctionAliasesService) {}

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Make an alias: a name pointing at a version or at $LATEST, and at most one more version with a share of its calls',
    description: "As AWS Lambda's CreateAlias. A weighted alias names a published version, as on Lambda, never $LATEST.",
  })
  @ApiResponse({ status: 201, type: FunctionAliasView })
  @ApiResponse({ status: 400, description: 'A share beside $LATEST, or beside the alias\'s own version' })
  @ApiResponse({ status: 404, description: 'No such function in the account, or no such version of it' })
  @ApiResponse({ status: 409, description: 'The function has an alias of that name already' })
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAliasDto, @Principal() principal: Principal): Promise<FunctionAliasView> {
    return this.aliases.create(principal.accountId, id, dto);
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's aliases, by name, as Lambda's ListAliases" })
  @ApiResponse({ status: 200, type: [FunctionAliasView] })
  list(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<FunctionAliasView[]> {
    return this.aliases.list(principal.accountId, id);
  }

  @Get(':name')
  @RequireScope('functions:read')
  @ApiOperation({ summary: "An alias, as Lambda's GetAlias" })
  @ApiResponse({ status: 200, type: FunctionAliasView })
  @ApiResponse({ status: 404, description: 'No such function in the account, or no such alias of it' })
  get(@Param('id', ParseUUIDPipe) id: string, @Param('name') name: string, @Principal() principal: Principal): Promise<FunctionAliasView> {
    return this.aliases.get(principal.accountId, id, name);
  }

  @Put(':name')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({ summary: 'Change an alias: what the body names changes, the rest stays', description: "As Lambda's UpdateAlias, revisionId checked when given" })
  @ApiResponse({ status: 200, type: FunctionAliasView })
  @ApiResponse({ status: 400, description: "A share beside $LATEST, or beside the alias's own version" })
  @ApiResponse({ status: 404, description: 'No such function in the account, no such alias of it, or no such version' })
  @ApiResponse({ status: 412, description: "revisionId given, and not the alias's: another change came between" })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @Body() dto: UpdateAliasDto,
    @Principal() principal: Principal,
  ): Promise<FunctionAliasView> {
    return this.aliases.update(principal.accountId, id, name, dto);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete an alias: the versions it named stay', description: "As Lambda's DeleteAlias" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such function in the account, or no such alias of it' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Param('name') name: string, @Principal() principal: Principal): Promise<void> {
    await this.aliases.remove(principal.accountId, id, name);
  }
}

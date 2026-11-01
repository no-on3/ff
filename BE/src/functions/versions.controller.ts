import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { FunctionVersionView, PublishVersionDto } from './dto/versions.dto';
import { FunctionVersionsService } from './versions.service';

/**
 * A function's versions, as AWS Lambda's: every member reads them; owners and
 * developers publish and delete them, as they change the function. Publishing
 * needs an active account; deleting doesn't.
 */
@ApiTags('functions')
@Controller('functions/:id/versions')
export class FunctionVersionsController {
  constructor(private readonly versions: FunctionVersionsService) {}

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Publish a version of the function: its code, settings and environment as they are now, frozen',
    description:
      "As AWS Lambda's PublishVersion: numbered 1, 2, 3…, a number never given twice, even once its version is deleted. When nothing but the " +
      'description changed since the last version, the answer is that version. The function keeps changing as $LATEST; a version never does.',
  })
  @ApiResponse({ status: 201, type: FunctionVersionView })
  @ApiResponse({ status: 400, description: "codeSha256 given, and not the function's code's" })
  @ApiResponse({ status: 409, description: "The function isn't ACTIVE: being deployed, or without working code" })
  @ApiResponse({ status: 412, description: "revisionId given, and not the function's: another change came between" })
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PublishVersionDto, @Principal() principal: Principal): Promise<FunctionVersionView> {
    return this.versions.publish(principal.accountId, id, dto);
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's versions, oldest first, as Lambda's ListVersionsByFunction lists them after $LATEST" })
  @ApiResponse({ status: 200, type: [FunctionVersionView] })
  list(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<FunctionVersionView[]> {
    return this.versions.list(principal.accountId, id);
  }

  @Get(':version')
  @RequireScope('functions:read')
  @ApiOperation({ summary: 'A version, with its variables as they were published, never its secrets' })
  @ApiResponse({ status: 200, type: FunctionVersionView })
  @ApiResponse({ status: 404, description: 'No such function in the account, or no such version of it' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Principal() principal: Principal,
  ): Promise<FunctionVersionView> {
    return this.versions.get(principal.accountId, id, version);
  }

  @Delete(':version')
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete a version: its number is never given again', description: "As Lambda's DeleteFunction of a version" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such function in the account, or no such version of it' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Principal() principal: Principal,
  ): Promise<void> {
    await this.versions.remove(principal.accountId, id, version);
  }
}

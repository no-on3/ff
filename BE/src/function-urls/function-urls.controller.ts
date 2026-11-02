import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CreateFunctionUrlDto, FunctionUrlView, UpdateFunctionUrlDto, UrlQualifierQuery } from './dto/function-url.dto';
import { FunctionUrlsService } from './function-urls.service';

/**
 * A function's URL, or its alias's, as AWS Lambda's function URL
 * configuration, the alias named by qualifier: every member reads it; owners
 * and developers give it, change it and delete it, as they change the
 * function. Deleting needs no active account: a suspended account may still
 * close its public address.
 */
@ApiTags('functions')
@Controller('functions/:id/url')
export class FunctionUrlsController {
  constructor(private readonly urls: FunctionUrlsService) {}

  @Post()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Give the function a URL, its public address',
    description:
      'At a random address, https://<32 letters and digits>.<the function domain>/, fixed until the URL is deleted. Every request to it, any method and ' +
      "path, calls the function with AWS Lambda's event for function URLs (API Gateway's payload format 2.0), and the function's answer is the " +
      "response, by Lambda's rules. The calls count as the API's invokes do: the plan's rate, the account's credit, the bill. With qualifier, the " +
      "alias's URL, whose calls run the version it names, its share drawn for each, as Lambda's; $LATEST's without it.",
  })
  @ApiResponse({ status: 201, type: FunctionUrlView })
  @ApiResponse({ status: 400, description: "The configuration was refused, or what the URL would call takes FF's original wrapped event, which a URL can't send" })
  @ApiResponse({ status: 404, description: 'No such function in the account, or no such alias' })
  @ApiResponse({ status: 409, description: 'The function, or the alias, already has a URL' })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UrlQualifierQuery,
    @Body() dto: CreateFunctionUrlDto,
    @Principal() principal: Principal,
  ): Promise<FunctionUrlView> {
    return this.urls.create(principal.accountId, id, dto, query.qualifier);
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's URL, or its alias's, and its configuration" })
  @ApiResponse({ status: 200, type: FunctionUrlView })
  @ApiResponse({ status: 404, description: 'No such function in the account, no such alias, or no URL' })
  get(@Param('id', ParseUUIDPipe) id: string, @Query() query: UrlQualifierQuery, @Principal() principal: Principal): Promise<FunctionUrlView> {
    return this.urls.get(principal.accountId, id, query.qualifier);
  }

  @Put()
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Change the URL's configuration",
    description: 'What is left out stays, as with AWS Lambda\'s UpdateFunctionUrlConfig; "cors": null removes CORS. The address stays.',
  })
  @ApiResponse({ status: 200, type: FunctionUrlView })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: UrlQualifierQuery,
    @Body() dto: UpdateFunctionUrlDto,
    @Principal() principal: Principal,
  ): Promise<FunctionUrlView> {
    return this.urls.update(principal.accountId, id, dto, query.qualifier);
  }

  @Delete()
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete the URL', description: 'Its address answers 404 at once. A new URL gets another address.' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Query() query: UrlQualifierQuery, @Principal() principal: Principal): Promise<void> {
    await this.urls.remove(principal.accountId, id, query.qualifier);
  }
}

/** A function's URLs together, as Lambda's ListFunctionUrlConfigs: every member reads them. */
@ApiTags('functions')
@Controller('functions/:id/urls')
export class FunctionUrlListController {
  constructor(private readonly urls: FunctionUrlsService) {}

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's URLs: $LATEST's first, if it has one, then its aliases' by name" })
  @ApiResponse({ status: 200, type: [FunctionUrlView] })
  list(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<FunctionUrlView[]> {
    return this.urls.list(principal.accountId, id);
  }
}

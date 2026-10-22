import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CreateFunctionUrlDto, FunctionUrlView, UpdateFunctionUrlDto } from './dto/function-url.dto';
import { FunctionUrlsService } from './function-urls.service';

/**
 * A function's URL, as AWS Lambda's function URL configuration: every member
 * reads it; owners and developers give it, change it and delete it, as they
 * change the function. Deleting needs no active account: a suspended account
 * may still close its public address.
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
      "response, by Lambda's rules. The calls count as the API's invokes do: the plan's rate, the account's credit, the bill.",
  })
  @ApiResponse({ status: 201, type: FunctionUrlView })
  @ApiResponse({ status: 400, description: "The configuration was refused, or the function takes FF's original wrapped event, which a URL can't send" })
  @ApiResponse({ status: 409, description: 'The function already has a URL' })
  create(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFunctionUrlDto, @Principal() principal: Principal): Promise<FunctionUrlView> {
    return this.urls.create(principal.accountId, id, dto);
  }

  @Get()
  @RequireScope('functions:read')
  @ApiOperation({ summary: "The function's URL and its configuration" })
  @ApiResponse({ status: 200, type: FunctionUrlView })
  @ApiResponse({ status: 404, description: 'No such function in the account, or it has no URL' })
  get(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<FunctionUrlView> {
    return this.urls.get(principal.accountId, id);
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
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFunctionUrlDto, @Principal() principal: Principal): Promise<FunctionUrlView> {
    return this.urls.update(principal.accountId, id, dto);
  }

  @Delete()
  @HttpCode(204)
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: 'Delete the URL', description: 'Its address answers 404 at once. A new URL gets another address.' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Principal() principal: Principal): Promise<void> {
    await this.urls.remove(principal.accountId, id);
  }
}

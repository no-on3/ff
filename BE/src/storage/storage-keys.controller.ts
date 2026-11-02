import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope } from '../auth/route-rules';
import { CreateStorageKeyDto, CreatedStorageKey, StorageKeyView } from './dto/storage.dto';
import { StorageKeysService } from './storage-keys.service';

/**
 * The account's access keys to its buckets, queues, mail and functions, as an
 * IAM user's: an ID and a secret for AWS's SDKs and CLI, shown once.
 * Credentials, as API keys are: its owners alone see, make and revoke them.
 * An API key makes one that reaches functions only with the scope for its
 * level, so that a key to storage can't give itself the right to deploy code.
 */
@ApiTags('storage keys')
@Controller('storage-keys')
export class StorageKeysController {
  constructor(private readonly keys: StorageKeysService) {}

  @Get()
  @RequireScope('storage:read')
  @RequireRole('owner')
  @ApiOperation({ summary: "The account's access keys to its buckets: never their secrets" })
  @ApiResponse({ status: 200, type: [StorageKeyView] })
  list(@Principal() principal: Principal): Promise<StorageKeyView[]> {
    return this.keys.list(principal.accountId);
  }

  @Post()
  @RequireScope('storage:write')
  @RequireRole('owner')
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Make an access key to the account's buckets, queues, mail or functions",
    description:
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for AWS's SDKs and CLI, with the endpoints and the region: the secret is in this answer only. As many as the plan's accessKeys. An API key makes one that reaches functions with the scope functions:read, functions:invoke or functions:write, as its functionAccess.",
  })
  @ApiResponse({ status: 201, type: CreatedStorageKey })
  @ApiResponse({ status: 400, description: "The account has as many keys as its plan allows, or the request isn't valid" })
  @ApiResponse({ status: 403, description: "The API key lacks the scope for the functions' level" })
  @ApiResponse({ status: 409, description: 'The account has a working key of that name' })
  create(@Body() dto: CreateStorageKeyDto, @Principal() principal: Principal): Promise<CreatedStorageKey> {
    const scope = dto.functionAccess && `functions:${dto.functionAccess}`;
    if (scope && principal.keyId && !principal.scopes?.includes(scope)) {
      throw new ForbiddenException(`This API key lacks the scope ${scope}, which a key that may ${dto.functionAccess} functions needs`);
    }
    return this.keys.create(principal.accountId, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireScope('storage:write')
  @RequireRole('owner')
  @ApiOperation({ summary: 'Revoke an access key', description: 'It stops working at once.' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such key in the account' })
  async revoke(@Param('id') id: string, @Principal() principal: Principal): Promise<void> {
    await this.keys.revoke(principal.accountId, id);
  }
}

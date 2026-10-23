import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope } from '../auth/route-rules';
import { CreateStorageKeyDto, CreatedStorageKey, StorageKeyView } from './dto/storage.dto';
import { StorageKeysService } from './storage-keys.service';

/**
 * The account's access keys to its buckets (ADR 0009), as an IAM user's: an ID
 * and a secret for AWS's SDKs and CLI, shown once. Credentials, as API keys
 * are: its owners alone see, make and revoke them.
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
    summary: 'Make an access key to the account\'s buckets',
    description:
      "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for AWS's SDKs and CLI, with the endpoint and the region: the secret is in this answer only. Two at most, as IAM gives a user, so that one can replace the other.",
  })
  @ApiResponse({ status: 201, type: CreatedStorageKey })
  @ApiResponse({ status: 409, description: 'The account has two keys already' })
  create(@Body() dto: CreateStorageKeyDto, @Principal() principal: Principal): Promise<CreatedStorageKey> {
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

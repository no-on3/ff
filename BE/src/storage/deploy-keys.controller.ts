import { Controller, Delete, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { CreatedDeployKey } from './dto/storage.dto';
import { StorageKeysService } from './storage-keys.service';

/**
 * A deploy's own key to a bucket, as `ff sites deploy` gets one to sign its
 * uploads with at the S3 endpoint: any member who may write the bucket, an API
 * key too; the bucket alone, for an hour. Never listed or counted with the
 * account's own keys, which its owners alone make.
 */
@ApiTags('buckets')
@Controller('buckets/:name/website/deploy-keys')
export class DeployKeysController {
  constructor(private readonly keys: StorageKeysService) {}

  @Post()
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "A key to the bucket alone, for a deploy's uploads",
    description:
      "An access key for AWS's SDKs and CLI that reaches this bucket alone, read-write, for an hour, then stops as a revoked key does: its secret in this answer only. " +
      '`ff sites deploy` gets one, signs its uploads and deletions with it at the S3 endpoint, and revokes it when it is done.',
  })
  @ApiResponse({ status: 201, type: CreatedDeployKey })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  create(@Param('name') name: string, @Principal() principal: Principal): Promise<CreatedDeployKey> {
    return this.keys.createDeployKey(principal.accountId, name);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "Revoke a deploy's key before its hour is up", description: 'It stops working at once.' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such bucket in the account, or no such deploy key to it' })
  async revoke(@Param('name') name: string, @Param('id') id: string, @Principal() principal: Principal): Promise<void> {
    await this.keys.revokeDeployKey(principal.accountId, name, id);
  }
}

import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { BucketsService } from './buckets.service';
import { BucketView, CreateBucketDto } from './dto/storage.dto';

/**
 * Customers' buckets (ADR 0009), as AWS S3 gives them, behind FF's S3 front
 * door: every member sees them; owners and developers make and delete them.
 * Deleting needs no active account: a suspended account may still delete its
 * data.
 */
@ApiTags('buckets')
@Controller('buckets')
export class BucketsController {
  constructor(private readonly buckets: BucketsService) {}

  @Get()
  @RequireScope('storage:read')
  @ApiOperation({ summary: "The account's buckets" })
  @ApiResponse({ status: 200, type: [BucketView] })
  list(@Principal() principal: Principal): Promise<BucketView[]> {
    return this.buckets.list(principal.accountId);
  }

  @Post()
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: 'Make a bucket',
    description:
      "Its name is unique across FF, as on AWS, and free again once it is deleted. AWS's SDKs and CLI reach it at the S3 endpoint with one of the account's access keys (POST /storage-keys), path-style or virtual-hosted.",
  })
  @ApiResponse({ status: 201, type: BucketView })
  @ApiResponse({ status: 400, description: 'The name was refused, or the plan allows no more buckets' })
  @ApiResponse({ status: 409, description: 'The name is taken' })
  @ApiResponse({ status: 503, description: "The store couldn't make it: nothing was made" })
  create(@Body() dto: CreateBucketDto, @Principal() principal: Principal): Promise<BucketView> {
    return this.buckets.create(principal.accountId, dto);
  }

  @Get(':name')
  @RequireScope('storage:read')
  @ApiOperation({ summary: 'A bucket: its endpoint, address and region' })
  @ApiResponse({ status: 200, type: BucketView })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  get(@Param('name') name: string, @Principal() principal: Principal): Promise<BucketView> {
    return this.buckets.get(principal.accountId, name);
  }

  @Delete(':name')
  @HttpCode(204)
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @ApiOperation({
    summary: 'Delete a bucket',
    description: 'An empty one, as S3 deletes one; with force=true, every object in it first, and every upload under way. Nothing can bring them back.',
  })
  @ApiQuery({ name: 'force', required: false, enum: ['true', 'false'] })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 409, description: "It isn't empty, and force wasn't asked" })
  async remove(@Param('name') name: string, @Query('force') force: string | undefined, @Principal() principal: Principal): Promise<void> {
    if (force !== undefined && force !== 'true' && force !== 'false') throw new BadRequestException('force must be true or false');
    await this.buckets.remove(principal.accountId, name, force === 'true');
  }
}

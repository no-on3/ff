import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireActiveAccount, RequireRole, RequireScope, WRITERS } from '../auth/route-rules';
import { BucketNotificationsService } from './bucket-notifications.service';
import { BucketWebsitesService } from './bucket-websites.service';
import { BucketsService } from './buckets.service';
import { NotificationConfigurationDto, NotificationConfigurationView } from './dto/notifications.dto';
import { BucketView, CreateBucketDto } from './dto/storage.dto';
import { WebsiteConfigurationDto, WebsiteView } from './dto/website.dto';

/**
 * Customers' buckets (ADR 0009), as AWS S3 gives them, behind FF's S3 front
 * door: every member sees them; owners and developers make and delete them.
 * Deleting needs no active account: a suspended account may still delete its
 * data.
 */
@ApiTags('buckets')
@Controller('buckets')
export class BucketsController {
  constructor(
    private readonly buckets: BucketsService,
    private readonly notifications: BucketNotificationsService,
    private readonly websites: BucketWebsitesService,
  ) {}

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

  @Get(':name/notifications')
  @RequireScope('storage:read')
  @ApiOperation({ summary: "A bucket's notification configuration, as S3's GetBucketNotificationConfiguration in its JSON names" })
  @ApiResponse({ status: 200, type: NotificationConfigurationView })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  getNotifications(@Param('name') name: string, @Principal() principal: Principal): Promise<NotificationConfigurationView> {
    return this.notifications.get(principal.accountId, name);
  }

  @Put(':name/notifications')
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Set a bucket's notification configuration, as S3's PutBucketNotificationConfiguration: replaced whole",
    description:
      "Each configuration sends the events it names (s3:ObjectCreated:* and its kinds, s3:ObjectRemoved:* and its), for the keys its filter's prefix and suffix name, " +
      "to a function of the account, called with S3's event without waiting, or to a queue of it, a message each; S3's test event goes to each queue named. " +
      'Two configurations that could take one event are refused, as S3 refuses them. An empty body removes them all.',
  })
  @ApiResponse({ status: 200, type: NotificationConfigurationView })
  @ApiResponse({ status: 400, description: "An event S3's buckets don't send, a filter or an ID refused, two configurations that overlap, or a destination that is no function or queue of the account" })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  putNotifications(@Param('name') name: string, @Body() dto: NotificationConfigurationDto, @Principal() principal: Principal): Promise<NotificationConfigurationView> {
    return this.notifications.put(principal.accountId, name, dto);
  }

  @Get(':name/website')
  @RequireScope('storage:read')
  @ApiOperation({ summary: "A bucket's website configuration, as S3's GetBucketWebsite in its JSON names, and its site's address" })
  @ApiResponse({ status: 200, type: WebsiteView })
  @ApiResponse({ status: 404, description: 'No such bucket in the account, or it is no site' })
  getWebsite(@Param('name') name: string, @Principal() principal: Principal): Promise<WebsiteView> {
    return this.websites.get(principal.accountId, name);
  }

  @Put(':name/website')
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  @ApiOperation({
    summary: "Make a bucket a site, as S3's PutBucketWebsite: its website configuration replaced whole",
    description:
      'Every file of the bucket is then public to read at its site, https://<bucket>.<the sites\' host>/, as S3 serves a website: a folder\'s path answers its index document, a path with no file the error document with 404, ' +
      'or, for a single-page app, the index document with 200. Its S3 API stays signed. Redirects and routing rules come later.',
  })
  @ApiResponse({ status: 200, type: WebsiteView })
  @ApiResponse({ status: 400, description: 'An index document with a slash, or a name too long' })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  putWebsite(@Param('name') name: string, @Body() dto: WebsiteConfigurationDto, @Principal() principal: Principal): Promise<WebsiteView> {
    return this.websites.put(principal.accountId, name, dto);
  }

  @Delete(':name/website')
  @HttpCode(204)
  @RequireScope('storage:write')
  @RequireRole(...WRITERS)
  @ApiOperation({ summary: "A bucket no longer a site, as S3's DeleteBucketWebsite: its files private again, and kept" })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  async removeWebsite(@Param('name') name: string, @Principal() principal: Principal): Promise<void> {
    await this.websites.remove(principal.accountId, name);
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

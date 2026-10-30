import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireScope } from '../auth/route-rules';
import { CustomerMetricsService } from './customer-metrics.service';
import { DATABASE_PERIOD, MetricsWindow, metricsWindow } from './customer-metrics';
import { BucketMetricsView, DatabaseMetricsView, MetricsQuery, MetricsView, QueueMetricsView, SiteMetricsView } from './dto/metrics-query.dto';

/** A window the request names, or 400 saying why it can't be. */
function windowOf(query: MetricsQuery): MetricsWindow {
  const window = metricsWindow(query, new Date());
  if ('problem' in window) throw new BadRequestException(window.problem);
  return window;
}

/**
 * The account's metrics, as CloudWatch names Lambda's, from its usage records
 * and capacity samples: a function's, or all its functions' together; a
 * database's, as CloudWatch names RDS's, from its hourly samples; a bucket's,
 * as CloudWatch names S3's, from its hourly samples and its requests; and a
 * queue's, as CloudWatch names SQS's, from its minute samples and its requests.
 */
@ApiTags('metrics')
@Controller()
export class MetricsController {
  constructor(private readonly metrics: CustomerMetricsService) {}

  @Get('functions/:id/metrics')
  @RequireScope('metrics:read')
  @ApiOperation({ summary: "A function's Invocations, Errors, Throttles, Duration, ColdStarts and Instances, a point per period" })
  @ApiResponse({ status: 200, type: MetricsView })
  forFunction(@Param('id', ParseUUIDPipe) id: string, @Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forFunction(principal.accountId, id, windowOf(query));
  }

  @Get('metrics')
  @RequireScope('metrics:read')
  @ApiOperation({ summary: "The account's metrics, all its functions together, those deleted since included" })
  @ApiResponse({ status: 200, type: MetricsView })
  forAccount(@Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forAccount(principal.accountId, windowOf(query));
  }

  @Get('databases/:id/metrics')
  @RequireScope('metrics:read')
  @ApiOperation({
    summary: "A database's DatabaseConnections and VolumeBytesUsed, as CloudWatch names RDS's and Aurora's: a point an hour",
    description: 'From its hourly samples: its sessions, and the bytes it uses, each hour; null for an hour it was not sampled in. The period is an hour, 3600 s, its default here.',
  })
  @ApiResponse({ status: 200, type: DatabaseMetricsView })
  @ApiResponse({ status: 404, description: 'No such database in the account' })
  forDatabase(@Param('id', ParseUUIDPipe) id: string, @Query() query: MetricsQuery, @Principal() principal: Principal) {
    if (query.period !== undefined && query.period !== DATABASE_PERIOD) throw new BadRequestException(`A database's metrics have a point an hour: period must be ${DATABASE_PERIOD}`);
    return this.metrics.forDatabase(principal.accountId, id, windowOf({ ...query, period: DATABASE_PERIOD }));
  }

  @Get('buckets/:name/metrics')
  @RequireScope('metrics:read')
  @ApiOperation({
    summary: "A bucket's BucketSizeBytes, NumberOfObjects and requests, as CloudWatch names S3's: a point per period",
    description:
      "What it holds and its objects, from its hourly measure: each period of an hour has the hour's, null in an hour it wasn't measured in. Its requests, each period's Sum, from the front door's counts by the minute: AllRequests, GetRequests, PutRequests, 4xxErrors, 5xxErrors, BytesDownloaded and BytesUploaded.",
  })
  @ApiResponse({ status: 200, type: BucketMetricsView })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  forBucket(@Param('name') name: string, @Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forBucket(principal.accountId, name, windowOf(query));
  }

  @Get('buckets/:name/website/metrics')
  @RequireScope('metrics:read')
  @ApiOperation({
    summary: "A bucket's site's visits, as CloudWatch names a CloudFront distribution's metrics: a point per period",
    description:
      "From the website server's counts by the minute: Requests and BytesDownloaded, each period's Sum; 4xxErrorRate, 5xxErrorRate and TotalErrorRate, the share of the visits answered 4xx, 5xx or either, in percent, each period's Average, null in a period without a visit. The bucket's own metrics count these visits among its requests.",
  })
  @ApiResponse({ status: 200, type: SiteMetricsView })
  @ApiResponse({ status: 404, description: 'No such bucket in the account' })
  forSite(@Param('name') name: string, @Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forSite(principal.accountId, name, windowOf(query));
  }

  @Get('queues/:name/metrics')
  @RequireScope('metrics:read')
  @ApiOperation({
    summary: "A queue's messages and requests, as CloudWatch names SQS's: a point per period",
    description:
      "Its messages that can be received, in flight and delayed, and its oldest message's age, sampled each minute: each period's Maximum and Average, a minute without a sample an empty queue's. From its requests' counts by the minute, each period's Sum: NumberOfMessagesSent, NumberOfMessagesReceived (a function's batches among them), NumberOfMessagesDeleted and NumberOfEmptyReceives; and SentMessageSize's Average and Maximum, null in a period without a message sent.",
  })
  @ApiResponse({ status: 200, type: QueueMetricsView })
  @ApiResponse({ status: 404, description: 'No such queue in the account' })
  forQueue(@Param('name') name: string, @Query() query: MetricsQuery, @Principal() principal: Principal) {
    return this.metrics.forQueue(principal.accountId, name, windowOf(query));
  }
}

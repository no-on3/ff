import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { PERIODS } from '../customer-metrics';

/** RFC 3339: a date, a time, and its zone. */
const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/;

/** GET /functions/:id/metrics and GET /metrics: a window, cut into periods. */
export class MetricsQuery {
  @ApiPropertyOptional({ example: '2026-10-19T09:00:00Z', description: "The window's start, RFC 3339, rounded down to a period; 60 periods before the end by default" })
  @IsOptional()
  @Matches(RFC3339, { message: 'start must be an RFC 3339 time, such as 2026-10-19T09:00:00Z' })
  start?: string;

  @ApiPropertyOptional({ example: '2026-10-19T10:00:00Z', description: "The window's end, RFC 3339, rounded up to a period; now by default" })
  @IsOptional()
  @Matches(RFC3339, { message: 'end must be an RFC 3339 time, such as 2026-10-19T10:00:00Z' })
  end?: string;

  @ApiPropertyOptional({ enum: PERIODS, default: 60, description: 'Seconds per point: a minute, five, or an hour. An answer has at most 1,440 points' })
  @IsOptional()
  @Type(() => Number)
  @IsIn([...PERIODS], { message: `period must be one of ${PERIODS.join(', ')} seconds` })
  period?: number;
}

class DurationSeries {
  @ApiProperty({ type: [Number], nullable: true, description: 'Milliseconds; null for a period without a measured call' }) Average: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) Maximum: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true, description: 'The median, interpolated' }) p50: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) p95: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) p99: Array<number | null>;
}

class InstancesSeries {
  @ApiProperty({ type: [Number], description: 'The most instances ready at once, in one of the period\'s minutes' }) Maximum: number[];
  @ApiProperty({ type: [Number], description: 'The mean over the period\'s minutes, a minute without one counting 0' }) Average: number[];
}

class AsyncEventAgeSeries {
  @ApiProperty({ type: [Number], nullable: true, description: "Milliseconds from an event's keeping to its attempt, the mean of the period's attempts; null for a period without one" }) Average: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true, description: 'The oldest of them' }) Maximum: Array<number | null>;
}

class MetricSeries {
  @ApiProperty({ type: [Number], description: 'Calls that reached a function, failed or not: all but the throttled' }) Invocations: number[];
  @ApiProperty({ type: [Number], description: "Calls that failed: the function's error or timeout, FF's failure, or lost when the backend stopped" }) Errors: number[];
  @ApiProperty({ type: [Number], description: 'Calls refused: no instance free in time, or the account\'s rate limit' }) Throttles: number[];
  @ApiProperty({ type: [Number], description: 'Calls that started an instance first' }) ColdStarts: number[];
  @ApiProperty({ type: DurationSeries }) Duration: DurationSeries;
  @ApiProperty({ type: InstancesSeries }) Instances: InstancesSeries;
  @ApiProperty({ type: [Number], description: 'Calls kept to run without waiting, as Lambda counts its asynchronous events received' }) AsyncEventsReceived: number[];
  @ApiProperty({ type: AsyncEventAgeSeries, description: "How long they waited for each attempt: Lambda's AsyncEventAge" }) AsyncEventAge: AsyncEventAgeSeries;
  @ApiProperty({ type: [Number], description: 'Those that ended without the function succeeding, past their retries or their age, sent to a destination or not' }) AsyncEventsDropped: number[];
  @ApiProperty({ type: [Number], description: "Records a destination didn't take: gone, too large, or the account's messages full" }) DestinationDeliveryFailures: number[];
}

/** A point per period of the window, oldest first. */
export class MetricsView {
  @ApiProperty({ enum: PERIODS }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each period's start" }) timestamps: Date[];
  @ApiProperty({ type: MetricSeries }) metrics: MetricSeries;
}

class DatabaseStatisticSeries {
  @ApiProperty({ type: [Number], nullable: true, description: "The most of the hour's samples; null for an hour without one" }) Maximum: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true, description: "The mean of the hour's samples; null for an hour without one" }) Average: Array<number | null>;
}

class DatabaseMetricSeries {
  @ApiProperty({ type: DatabaseStatisticSeries, description: 'Its sessions, as the server counts them' }) DatabaseConnections: DatabaseStatisticSeries;
  @ApiProperty({ type: DatabaseStatisticSeries, description: 'The bytes it uses: pg_database_size' }) VolumeBytesUsed: DatabaseStatisticSeries;
}

/** A database's metrics: a point an hour of the window, oldest first. */
export class DatabaseMetricsView {
  @ApiProperty({ example: 3600 }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each hour's start" }) timestamps: Date[];
  @ApiProperty({ type: DatabaseMetricSeries }) metrics: DatabaseMetricSeries;
}

class CacheStatisticSeries {
  @ApiProperty({ type: [Number], nullable: true, description: "The most of the hour's samples; null for an hour without one" }) Maximum: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true, description: "The mean of the hour's samples; null for an hour without one" }) Average: Array<number | null>;
}

class CacheCountSeries {
  @ApiProperty({ type: [Number], nullable: true, description: "The hour's, from the next hour's sample less its own; null without both, as in the hour now" }) Sum: Array<number | null>;
}

class CacheMetricSeries {
  @ApiProperty({ type: CacheStatisticSeries, description: "What its keys and their overhead use: INFO's used_memory" }) BytesUsedForCache: CacheStatisticSeries;
  @ApiProperty({ type: CacheStatisticSeries, description: "Its connections, FF's own left out" }) CurrConnections: CacheStatisticSeries;
  @ApiProperty({ type: CacheCountSeries, description: 'Reads that found their key' }) CacheHits: CacheCountSeries;
  @ApiProperty({ type: CacheCountSeries, description: "Reads that didn't" }) CacheMisses: CacheCountSeries;
  @ApiProperty({ type: CacheCountSeries, description: 'Keys it let go past its memory, the least recently used first' }) Evictions: CacheCountSeries;
}

/** A cache's metrics: a point an hour of the window, oldest first. */
export class CacheMetricsView {
  @ApiProperty({ example: 3600 }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each hour's start" }) timestamps: Date[];
  @ApiProperty({ type: CacheMetricSeries }) metrics: CacheMetricSeries;
}

class BucketStorageSeries {
  @ApiProperty({ type: [Number], nullable: true, description: "Its hour's measure, in each period of the hour; null in an hour it wasn't measured in" }) Average: Array<number | null>;
}

class BucketRequestSeries {
  @ApiProperty({ type: [Number], description: "The period's total; 0 for a quiet period" }) Sum: number[];
}

class BucketMetricSeries {
  @ApiProperty({ type: BucketStorageSeries, description: "The bytes it holds: its objects' sizes, as its listing gives them" }) BucketSizeBytes: BucketStorageSeries;
  @ApiProperty({ type: BucketStorageSeries, description: 'Its objects' }) NumberOfObjects: BucketStorageSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'The requests to it that the front door answered' }) AllRequests: BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'Of them, the HTTP GETs' }) GetRequests: BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'Of them, the HTTP PUTs' }) PutRequests: BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'Of them, those answered 4xx' }) '4xxErrors': BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'Of them, those answered 5xx' }) '5xxErrors': BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'The bytes of the bodies it sent' }) BytesDownloaded: BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'The bytes of the bodies it took' }) BytesUploaded: BucketRequestSeries;
}

/** A bucket's metrics: a point per period of the window, oldest first. */
export class BucketMetricsView {
  @ApiProperty({ enum: PERIODS }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each period's start" }) timestamps: Date[];
  @ApiProperty({ type: BucketMetricSeries }) metrics: BucketMetricSeries;
}

class SiteShareSeries {
  @ApiProperty({ type: [Number], nullable: true, description: "The period's share of the site's visits, in percent; null in a period without a visit" }) Average: Array<number | null>;
}

class SiteMetricSeries {
  @ApiProperty({ type: BucketRequestSeries, description: "The site's visits that the website server answered" }) Requests: BucketRequestSeries;
  @ApiProperty({ type: BucketRequestSeries, description: 'The bytes of the bodies it sent them' }) BytesDownloaded: BucketRequestSeries;
  @ApiProperty({ type: SiteShareSeries, description: 'The share of them answered 4xx' }) '4xxErrorRate': SiteShareSeries;
  @ApiProperty({ type: SiteShareSeries, description: 'The share of them answered 5xx' }) '5xxErrorRate': SiteShareSeries;
  @ApiProperty({ type: SiteShareSeries, description: 'The share of them answered 4xx or 5xx' }) TotalErrorRate: SiteShareSeries;
}

/** GET /buckets/:name/website/metrics: a site's visits, as CloudWatch names a CloudFront distribution's metrics. */
export class SiteMetricsView {
  @ApiProperty({ enum: PERIODS }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each period's start" }) timestamps: Date[];
  @ApiProperty({ type: SiteMetricSeries }) metrics: SiteMetricSeries;
}

class QueueGaugeSeries {
  @ApiProperty({ type: [Number], description: "The most of the period's minutes; 0 where the queue was empty" }) Maximum: number[];
  @ApiProperty({ type: [Number], description: "The mean over the period's minutes, a minute without a sample counting 0" }) Average: number[];
}

class QueueAgeSeries {
  @ApiProperty({ type: [Number], description: "Seconds: the oldest message's age, the most of the period's minutes; 0 where the queue was empty" }) Maximum: number[];
}

class QueueCountSeries {
  @ApiProperty({ type: [Number], description: "The period's total; 0 for a quiet period" }) Sum: number[];
}

class QueueSizeSeries {
  @ApiProperty({ type: [Number], nullable: true, description: 'Bytes, body and attributes; null for a period without a message sent' }) Average: Array<number | null>;
  @ApiProperty({ type: [Number], nullable: true }) Maximum: Array<number | null>;
}

class QueueMetricSeries {
  @ApiProperty({ type: QueueGaugeSeries, description: 'Messages that can be received' }) ApproximateNumberOfMessagesVisible: QueueGaugeSeries;
  @ApiProperty({ type: QueueGaugeSeries, description: 'Messages received and hidden for their visibility timeout' }) ApproximateNumberOfMessagesNotVisible: QueueGaugeSeries;
  @ApiProperty({ type: QueueGaugeSeries, description: 'Messages waiting for their delay' }) ApproximateNumberOfMessagesDelayed: QueueGaugeSeries;
  @ApiProperty({ type: QueueAgeSeries }) ApproximateAgeOfOldestMessage: QueueAgeSeries;
  @ApiProperty({ type: QueueCountSeries, description: 'Messages kept in it' }) NumberOfMessagesSent: QueueCountSeries;
  @ApiProperty({ type: QueueCountSeries, description: "Messages received from it, a function's batches among them" }) NumberOfMessagesReceived: QueueCountSeries;
  @ApiProperty({ type: QueueCountSeries, description: 'Messages deleted by a valid receipt handle' }) NumberOfMessagesDeleted: QueueCountSeries;
  @ApiProperty({ type: QueueCountSeries, description: 'Receives that found no message' }) NumberOfEmptyReceives: QueueCountSeries;
  @ApiProperty({ type: QueueSizeSeries, description: 'The size of the messages kept' }) SentMessageSize: QueueSizeSeries;
}

/** A queue's metrics: a point per period of the window, oldest first. */
export class QueueMetricsView {
  @ApiProperty({ enum: PERIODS }) period: number;
  @ApiProperty() start: Date;
  @ApiProperty({ description: 'Excluded' }) end: Date;
  @ApiProperty({ type: [Date], description: "Each period's start" }) timestamps: Date[];
  @ApiProperty({ type: QueueMetricSeries }) metrics: QueueMetricSeries;
}

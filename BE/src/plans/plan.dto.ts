import { ApiProperty } from '@nestjs/swagger';
import { PlanLimits } from './plan-limits';

class QuotaView {
  @ApiProperty({ example: 20, description: 'Pods: instances of all functions together' }) pods: number;
  @ApiProperty({ example: '8', description: 'CPU, as a Kubernetes quantity' }) cpu: string;
  @ApiProperty({ example: '8Gi', description: 'Memory, as a Kubernetes quantity' }) memory: string;
}

/** A plan's limits, as GET /me shows them (D5). */
export class PlanLimitsView implements PlanLimits {
  @ApiProperty({ example: 25, description: 'Functions per account' }) functions: number;
  @ApiProperty({ example: 1024, description: 'The most memory one function may have, in MB' }) memoryMb: number;
  @ApiProperty({ example: 300, description: 'The longest timeout one function may have, in seconds' }) timeoutSeconds: number;
  @ApiProperty({ example: 10, description: 'The most instances one function may run' }) instancesPerFunction: number;
  @ApiProperty({ type: QuotaView, description: "The account's quota, for all its functions together" }) quota: QuotaView;
  @ApiProperty({ example: 60, description: 'Changes per minute: creating, changing and deleting' }) writesPerMinute: number;
  @ApiProperty({ example: 100, description: 'Invocations per second, all functions together' }) invokesPerSecond: number;
  @ApiProperty({ example: 14, description: 'Days of function logs kept' }) logRetentionDays: number;
  @ApiProperty({ example: 30, description: 'Days of invocation history kept' }) historyRetentionDays: number;
  @ApiProperty({ example: 900, description: 'Seconds without a call before a function scales to zero' }) idleSeconds: number;
  @ApiProperty({ example: false, description: 'Whether functions may reach the internet' }) internetEgress: boolean;
  @ApiProperty({ example: 5, description: "Customers' own domains for their functions' URLs, all together" }) customDomains: number;
  @ApiProperty({ example: 20, description: "Functions' schedules, all together" }) schedules: number;
  @ApiProperty({ example: 1, description: "Customers' PostgreSQL databases, all together" }) databases: number;
  @ApiProperty({ example: 1024, description: 'What one database may hold, in MB, before its new sessions start read-only' }) databaseStorageMb: number;
  @ApiProperty({ example: 10, description: 'The sessions one database may have at once' }) databaseConnections: number;
  @ApiProperty({ example: 5, description: "Customers' buckets, all together" }) buckets: number;
  @ApiProperty({ example: 5120, description: "What the account's buckets may hold together, in MB" }) bucketStorageMb: number;
  @ApiProperty({ example: 100, description: 'S3 requests per second, all the keys together' }) storageRequestsPerSecond: number;
  @ApiProperty({ example: 5120, description: 'The largest object one PutObject may send, in MB' }) maxObjectMb: number;
  @ApiProperty({ example: 10, description: "What the account's sites may send out in a month, in GB, all together" }) siteTransferGbPerMonth: number;
  @ApiProperty({ example: 10, description: "Customers' queues, all together" }) queues: number;
  @ApiProperty({ example: 5, description: 'The queues one function may read in batches' }) eventSourceMappingsPerFunction: number;
  @ApiProperty({ example: 100, description: 'SQS requests per second, all the keys together' }) queueRequestsPerSecond: number;
  @ApiProperty({ example: 100, description: "What the account's messages may hold together, in MB, its functions' waiting asynchronous calls among them" })
  queueStorageMb: number;
}

/** An account's plan. */
export class PlanSummary {
  @ApiProperty({ example: 'beta' }) id: string;
  @ApiProperty({ example: 'Beta' }) name: string;
  @ApiProperty({ type: PlanLimitsView }) limits: PlanLimitsView;
}

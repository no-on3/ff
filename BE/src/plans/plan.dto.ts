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
}

/** An account's plan. */
export class PlanSummary {
  @ApiProperty({ example: 'beta' }) id: string;
  @ApiProperty({ example: 'Beta' }) name: string;
  @ApiProperty({ type: PlanLimitsView }) limits: PlanLimitsView;
}

import { z } from 'zod';

/**
 * The most any plan may allow: what the platform itself can run. Requests are
 * validated against these first; the account's plan then sets its own, lower
 * limits, and says so in its refusals (D5).
 */
export const PLATFORM_LIMITS = {
  /** The tenant LimitRange's largest container (manifests.ts). */
  memoryMb: 10_240,
  /** Lambda's longest timeout. */
  timeoutSeconds: 900,
  instancesPerFunction: 100,
} as const;

/** The plan every new account starts on (D5). */
export const DEFAULT_PLAN = 'beta';

const positive = z.number().int().positive();
const quantity = z.string().regex(/^\d+(\.\d+)?(m|k|M|G|T|Ki|Mi|Gi|Ti)?$/, 'must be a Kubernetes quantity, such as 8, 500m or 8Gi');

/** What a plan holds (D5): `plans.limits`, which the admin dashboard edits (P-73). */
export const planLimitsSchema = z.strictObject({
  /** Functions per account. */
  functions: positive,
  /** The most memory one function may have, in MB. */
  memoryMb: z.number().int().min(128).max(PLATFORM_LIMITS.memoryMb),
  /** The longest timeout one function may have, in seconds. */
  timeoutSeconds: z.number().int().min(1).max(PLATFORM_LIMITS.timeoutSeconds),
  /** The most instances one function may run (its maxInstances, and so its minInstances). */
  instancesPerFunction: z.number().int().min(1).max(PLATFORM_LIMITS.instancesPerFunction),
  /** The account namespace's ResourceQuota: all its functions together. */
  quota: z.strictObject({ pods: positive, cpu: quantity, memory: quantity }),
  /** Control-plane changes per minute: creating, changing and deleting functions, keys and accounts. */
  writesPerMinute: positive,
  /** Invocations per second, all the account's functions together. */
  invokesPerSecond: positive,
  /** How long function logs are kept (P-43). */
  logRetentionDays: positive,
  /** How long invocation history is kept (P-45). */
  historyRetentionDays: positive,
  /** How long a function stays up after its last call before it scales to zero. */
  idleSeconds: positive,
  /** Whether functions may reach the internet; P-62 applies it per account. */
  internetEgress: z.boolean(),
  /** Customers' own domains for their functions' URLs, all the account's together. */
  customDomains: z.number().int().min(0),
  /** Functions' schedules, all the account's together. */
  schedules: z.number().int().min(0),
  /** Customers' databases, the account's together (ADR 0008). */
  databases: z.number().int().min(0),
  /** What one database may hold, in MB: past it, its new sessions start read-only, and what is above is billed. */
  databaseStorageMb: positive,
  /** The sessions one database may have at once: its user's CONNECTION LIMIT on the server. */
  databaseConnections: positive,
  /** Customers' buckets, the account's together (ADR 0009). */
  buckets: z.number().int().min(0),
  /** What the account's buckets may hold together, in MB: S3's free tier, 5 GB, on beta. */
  bucketStorageMb: positive,
  /** S3 requests per second, the account's keys together: past it, the front door answers SlowDown, as S3 does. */
  storageRequestsPerSecond: positive,
  /** The largest object one PutObject may send, in MB: S3's own limit is 5 GB. */
  maxObjectMb: positive,
  /** What the account's sites may send out in a month, in GB, all its buckets' together: past it, they answer 403 until the next. */
  siteTransferGbPerMonth: positive,
  /** Customers' queues, the account's together (ADR 0010). */
  queues: z.number().int().min(0),
  /** The queues one function may read in batches: its event source mappings. */
  eventSourceMappingsPerFunction: z.number().int().min(0),
  /** SQS requests per second, the account's keys together. */
  queueRequestsPerSecond: positive,
  /** What the account's messages may hold together, in MB, its functions' asynchronous calls waiting to run among them. */
  queueStorageMb: positive,
  /** Customers' caches, the account's together (ADR 0013). */
  caches: z.number().int().min(0),
  /** One cache's memory, in MB, as Valkey's maxmemory: past it, its least recently used keys go. */
  cacheMb: positive,
  /** The domains the account may send mail from, its proved addresses apart (ADR 0012). */
  emailIdentities: z.number().int().min(0),
  /** Messages a day, each recipient one, as SES's Max24HourSend: the sandbox's 200 on beta. */
  emailsPerDay: z.number().int().min(0),
  /** Messages a second, as SES's MaxSendRate. */
  emailsPerSecond: positive,
});

export type PlanLimits = z.infer<typeof planLimitsSchema>;

/** A plan, as the backend uses it. */
export interface PlanView {
  id: string;
  name: string;
  limits: PlanLimits;
}

/** A plan's limits, checked: a plan that lacks one, or has a wrong one, stops the request (a platform failure). */
export function parsePlanLimits(planId: string, value: unknown): PlanLimits {
  const parsed = planLimitsSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'limits'}: ${issue.message}`);
  throw new Error(`The plan "${planId}" has invalid limits: ${problems.join('; ')}`);
}

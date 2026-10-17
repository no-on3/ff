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

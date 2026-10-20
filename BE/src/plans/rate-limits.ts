import { ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { RequestWithPrincipal } from '../auth/principal';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { DEFAULT_PLAN, PlanView } from './plan-limits';
import { PlansService } from './plans.service';
import { refusals } from '../monitoring/operator-metrics';

/** Marks the route that invokes functions: it counts against the plan's invokesPerSecond, not writesPerMinute. */
export const INVOCATION = 'ff:invocation';
export const Invocation = () => SetMetadata(INVOCATION, true);

/** D5's two rate limits, per account: control-plane changes, and invocations. */
export const RATE_LIMITS = {
  writes: { ttlMs: 60_000, limit: 'writesPerMinute', describe: (n: number) => `${n} changes per minute` },
  invokes: { ttlMs: 1_000, limit: 'invokesPerSecond', describe: (n: number) => `${n} invocations per second` },
} as const;
export type RateLimitName = keyof typeof RATE_LIMITS;

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Which limit a request counts against: invocations, other changes, or none: reads are not limited. */
export function rateLimitOf(method: string, invocation: boolean): RateLimitName | null {
  if (invocation) return 'invokes';
  return CHANGES.has(method.toUpperCase()) ? 'writes' : null;
}

type RateLimitedRequest = RequestWithPrincipal & { method: string; ip?: string; user?: { id: string }; operator?: { id: string } };

/**
 * Whose count a request adds to: its account's; before the user has one, the
 * user's; an operator's own on the admin routes (P-70); without a login, its
 * address's.
 */
export function rateLimitTracker(request: RateLimitedRequest): string {
  if (request.principal) return `account:${request.principal.accountId}`;
  if (request.operator) return `operator:${request.operator.id}`;
  if (request.user) return `user:${request.user.id}`;
  return `ip:${request.ip ?? 'unknown'}`;
}

/** The plan whose limits apply: the account's, else the plan a new account gets. */
const planOf = (plans: PlansService, request: RateLimitedRequest): Promise<PlanView> =>
  plans.get(request.principal?.planId ?? DEFAULT_PLAN);

/**
 * The throttler's settings: one window per limit, sized by the plan, and one
 * count per account across all routes, not one per route (the throttler's default).
 * Counts are kept in memory while there is one backend replica (D5).
 */
export function rateLimitOptions(plans: PlansService, reflector: Reflector): ThrottlerModuleOptions {
  const kindOf = (context: ExecutionContext) =>
    rateLimitOf(
      context.switchToHttp().getRequest<RateLimitedRequest>().method,
      Boolean(reflector.getAllAndOverride<boolean>(INVOCATION, [context.getHandler(), context.getClass()])),
    );
  return {
    setHeaders: false, // Retry-After only, on a refusal
    getTracker: (request) => rateLimitTracker(request as RateLimitedRequest),
    generateKey: (_context, tracker, name) => `${name}:${tracker}`,
    throttlers: (Object.keys(RATE_LIMITS) as RateLimitName[]).map((name) => ({
      name,
      ttl: RATE_LIMITS[name].ttlMs,
      limit: async (context: ExecutionContext) =>
        (await planOf(plans, context.switchToHttp().getRequest<RateLimitedRequest>())).limits[RATE_LIMITS[name].limit],
      skipIf: (context: ExecutionContext) => kindOf(context) !== name,
    })),
  };
}

/**
 * The global throttler (D5). It runs after the AuthGuard, which finds the
 * account a request counts against, and refuses as Lambda does: 429
 * TooManyRequestsException, with Retry-After in seconds.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly plans: PlansService,
    private readonly refused: RefusedInvocationsService,
  ) {
    super(options, storage, reflector);
  }

  protected override async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const { req, res } = this.getRequestResponse(context);
    const name = detail.key.slice(0, detail.key.indexOf(':')) as RateLimitName;
    const plan = await planOf(this.plans, req as RateLimitedRequest);
    // A refused invocation reached no function and has no usage record: the Throttles metric counts it here.
    const principal = (req as RateLimitedRequest).principal;
    if (name === 'invokes' && principal) {
      this.refused.count(principal.accountId, (req as { params?: { id?: string } }).params?.id);
      refusals.inc({ reason: 'rate_limit' });
    }
    this.setResponseHeader(res, 'Retry-After', detail.timeToBlockExpire);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'Too Many Requests',
        message: `TooManyRequestsException: Rate exceeded: the ${plan.name} plan allows ${RATE_LIMITS[name].describe(detail.limit)}. Retry after ${detail.timeToBlockExpire} s.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

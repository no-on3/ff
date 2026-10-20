/**
 * L1: the per-account rate limits (client-readiness plan, P-15, D5), through a
 * real HTTP server with the throttler as the backend sets it up. A stand-in for
 * the AuthGuard runs first, as the real one does: it puts the account and its
 * plan on the request, from test headers.
 */
import { CanActivate, Controller, ExecutionContext, Get, INestApplication, Module, Param, Post, Put } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountStatus } from '../accounts/entities/account.entity';
import { RequestWithPrincipal } from '../auth/principal';
import { PlanView } from './plan-limits';
import { PlansService } from './plans.service';
import { Invocation, RateLimitGuard, rateLimitOf, rateLimitOptions } from './rate-limits';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { refusals } from '../monitoring/operator-metrics';
import { valueOf } from '../monitoring/test-fixtures';
import { plan } from './test-fixtures';

@Controller('probe')
class ProbeController {
  @Get()
  read() {
    return { ok: true };
  }

  @Post()
  create() {
    return { ok: true };
  }

  @Put(':id')
  change(@Param('id') id: string) {
    return { id };
  }

  @Post(':id/invoke')
  @Invocation()
  invoke(@Param('id') id: string) {
    return { id };
  }
}

/** Where the AuthGuard would put the caller: here, from the x-account and x-plan headers, or x-operator on an admin route. */
class StandInAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal & { headers: Record<string, string>; operator?: { id: string; email: string } }>();
    if (request.headers['x-operator']) request.operator = { id: request.headers['x-operator'], email: 'operator@ff.test' };
    const accountId = request.headers['x-account'];
    if (accountId) {
      request.principal = { accountId, planId: request.headers['x-plan'] ?? 'beta', accountStatus: AccountStatus.ACTIVE, role: 'owner' };
    }
    return true;
  }
}

const PLANS: Record<string, PlanView> = {
  beta: plan({ writesPerMinute: 5, invokesPerSecond: 4 }),
  tight: plan({ writesPerMinute: 3, invokesPerSecond: 2 }, 'tight', 'Tight'),
};
const plans = { get: async (id: string) => PLANS[id] } as unknown as PlansService;
/** What the Throttles metric is told of each refused invocation. */
const refusedCount = { count: jest.fn() };

@Module({ providers: [{ provide: PlansService, useValue: plans }], exports: [PlansService] })
class FakePlansModule {}

describe('rate limits per account (L1, P-15)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakePlansModule,
        ThrottlerModule.forRootAsync({
          imports: [FakePlansModule],
          inject: [PlansService, Reflector],
          useFactory: (service: PlansService, reflector: Reflector) => rateLimitOptions(service, reflector),
        }),
      ],
      controllers: [ProbeController],
      providers: [
        { provide: APP_GUARD, useClass: StandInAuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: RefusedInvocationsService, useValue: refusedCount },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  const call = (method: string, path: string, account?: string, planId?: string) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(account ? { 'x-account': account } : {}), ...(planId ? { 'x-plan': planId } : {}) },
    });
  const statuses = async (calls: Array<() => Promise<Response>>) => {
    const result: number[] = [];
    for (const next of calls) result.push((await next()).status);
    return result;
  };

  it("counts an account's changes on every route together, against its plan's writesPerMinute", async () => {
    const changes = [() => call('POST', '/probe', 'a1', 'tight'), () => call('PUT', '/probe/1', 'a1', 'tight'), () => call('PUT', '/probe/2', 'a1', 'tight')];

    const refusedBefore = await valueOf(refusals, { reason: 'rate_limit' });
    expect(await statuses(changes)).toEqual([201, 200, 200]);
    const refused = await call('POST', '/probe', 'a1', 'tight');

    expect(refused.status).toBe(429);
    expect(refusedCount.count).not.toHaveBeenCalled(); // a refused change reached no function: no Throttles
    expect(await valueOf(refusals, { reason: 'rate_limit' })).toBe(refusedBefore); // nor an invocation refused, for the operator
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(55);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(await refused.json()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `TooManyRequestsException: Rate exceeded: the Tight plan allows 3 changes per minute. Retry after ${retryAfter} s.`,
    });
  });

  it("doesn't limit reads, even for an account that has run out of changes", async () => {
    expect(await statuses(Array.from({ length: 10 }, () => () => call('GET', '/probe', 'a1', 'tight')))).toEqual(Array(10).fill(200));
  });

  it("keeps invocations apart: their own limit, per second, which a minute's changes don't use up", async () => {
    const invoke = () => call('POST', '/probe/f/invoke', 'a1', 'tight');
    const refusedBefore = await valueOf(refusals, { reason: 'rate_limit' });

    expect(await statuses([invoke, invoke, invoke])).toEqual([201, 201, 429]);
    const refused = await invoke();
    // Each refused invocation, for its account and the function the path names: the Throttles metric counts them.
    expect(refusedCount.count.mock.calls).toEqual([
      ['a1', 'f'],
      ['a1', 'f'],
    ]);
    // And the operator's metrics, for all accounts together.
    expect(await valueOf(refusals, { reason: 'rate_limit' })).toBe(refusedBefore + 2);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /^TooManyRequestsException: Rate exceeded: the Tight plan allows 2 invocations per second\. Retry after 1 s\.$/,
    );

    await new Promise((resolve) => setTimeout(resolve, 1100)); // the window has passed
    expect((await invoke()).status).toBe(201);
  });

  it("gives each account its own count, though they call from the same address", async () => {
    expect(await statuses([() => call('POST', '/probe', 'a2', 'tight')])).toEqual([201]);
  });

  it("sizes the limits by the account's plan", async () => {
    const change = () => call('POST', '/probe', 'b1', 'beta');

    expect(await statuses([change, change, change, change, change, change])).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('counts a caller without an account by its address, on the plan new accounts get', async () => {
    const anonymous = () => call('POST', '/probe');

    expect(await statuses([anonymous, anonymous, anonymous, anonymous, anonymous, anonymous])).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it('counts each operator apart, though they call from the same address as others, on the plan new accounts get (P-70)', async () => {
    const asOperator = (id: string) => () => fetch(`${baseUrl}/probe`, { method: 'POST', headers: { 'x-operator': id } });

    expect(await statuses(Array.from({ length: 6 }, () => asOperator('op-1')))).toEqual([201, 201, 201, 201, 201, 429]);
    expect(await statuses([asOperator('op-2')])).toEqual([201]);
  });
});

describe('rateLimitOf', () => {
  it.each([
    ['POST', true, 'invokes'],
    ['POST', false, 'writes'],
    ['PUT', false, 'writes'],
    ['PATCH', false, 'writes'],
    ['DELETE', false, 'writes'],
    ['GET', false, null],
    ['HEAD', false, null],
    ['OPTIONS', false, null],
  ])('%s, an invocation: %s → %s', (method, invocation, expected) => {
    expect(rateLimitOf(method, invocation)).toBe(expected);
  });
});

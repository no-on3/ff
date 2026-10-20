/**
 * L1: a request's context as main.ts sets it up, through a real HTTP server.
 * The middleware gives the request its ID before anything else runs, so the
 * guards' log lines name it too (the interceptor alone came after them); the
 * interceptor then adds the caller the guards found. Each answer is counted by
 * its status class for the operator's metrics.
 */
import { CanActivate, Controller, ExecutionContext, ForbiddenException, Get, INestApplication, Injectable } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { httpResponses } from '../monitoring/operator-metrics';
import { ApiExceptionFilter } from './api-exception.filter';
import { REQUEST_ID_HEADER, RequestIdInterceptor, currentRequest, currentRequestId, requestContextMiddleware } from './request-context';

/** What the guard saw of the request's context, by the path it guarded. */
const seenByGuard = new Map<string, string | undefined>();

/** Like the backend's own guard: finds the caller, and may refuse. */
@Injectable()
class CallerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ url: string; user?: { id: string; email: string } }>();
    seenByGuard.set(request.url, currentRequestId());
    if (request.url.endsWith('/refused')) throw new ForbiddenException('Not yours');
    request.user = { id: 'u-1', email: 'owner@example.tn' };
    return true;
  }
}

@Controller('probe')
class ProbeController {
  @Get('context')
  async context() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return currentRequest();
  }

  @Get('refused')
  refused() {
    return 'never';
  }

  @Get('broken')
  broken() {
    throw new Error('the database went away');
  }
}

const count = async (statusClass: string) => (await httpResponses.get()).values.find((value) => value.labels.class === statusClass)?.value ?? 0;

describe("a request's context, begun by the middleware", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_GUARD, useClass: CallerGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(requestContextMiddleware);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  it("is seen by the guards, then the handler, with the caller the guards found, and the answer's ID", async () => {
    const res = await fetch(`${baseUrl}/probe/context`);
    const id = res.headers.get(REQUEST_ID_HEADER);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seenByGuard.get('/probe/context')).toBe(id);
    expect(await res.json()).toEqual({ requestId: id, ip: expect.stringContaining('127.0.0.1'), actor: { id: 'user:u-1', label: 'owner@example.tn' } });
  });

  it('names a request the guards refused, in its answer and in what they logged', async () => {
    const res = await fetch(`${baseUrl}/probe/refused`);
    const id = res.headers.get(REQUEST_ID_HEADER);

    expect(res.status).toBe(403);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seenByGuard.get('/probe/refused')).toBe(id);
  });

  it('counts each answer by its status class, once, when it is sent', async () => {
    const before = { ok: await count('2xx'), refused: await count('4xx'), failed: await count('5xx') };

    await fetch(`${baseUrl}/probe/context`);
    await fetch(`${baseUrl}/probe/refused`);
    await fetch(`${baseUrl}/probe/nowhere`);
    await (await fetch(`${baseUrl}/probe/broken`)).text();
    // 'finish' is emitted once the answer is handed to the system, which may be after the client has it.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect({ ok: await count('2xx'), refused: await count('4xx'), failed: await count('5xx') }).toEqual({
      ok: before.ok + 1,
      refused: before.refused + 2,
      failed: before.failed + 1,
    });
  });

  it('keeps one request out of another, sent together', async () => {
    const answers = await Promise.all([1, 2, 3, 4].map(() => fetch(`${baseUrl}/probe/context`)));
    const ids = await Promise.all(answers.map(async (res) => ({ header: res.headers.get(REQUEST_ID_HEADER), seen: ((await res.json()) as { requestId: string }).requestId })));

    expect(ids.every(({ header, seen }) => header === seen)).toBe(true);
    expect(new Set(ids.map(({ seen }) => seen)).size).toBe(4);
  });
});

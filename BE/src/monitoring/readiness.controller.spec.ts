/**
 * L1: GET /readyz, through a real HTTP server with the backend's exception
 * filter. A load balancer or Kubernetes' readiness probe stops sending traffic
 * to a backend that can't serve: one whose database or cluster doesn't answer,
 * or doesn't answer in time. /healthz only says the process is alive.
 */
import { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { ORCHESTRATOR } from '../orchestrator/orchestrator.types';
import { CHECK_MS, ReadinessController } from './readiness.controller';

describe('GET /readyz', () => {
  const database = { query: jest.fn<Promise<unknown>, [string]>() };
  const orchestrator = { ping: jest.fn<Promise<void>, [number]>() };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReadinessController],
      providers: [
        { provide: DataSource, useValue: database },
        { provide: ORCHESTRATOR, useValue: orchestrator },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    database.query.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    orchestrator.ping.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => app.close());

  const ready = async () => {
    // Given up after a while, so that a check that never answers fails the test rather than hang it.
    const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(CHECK_MS + 1500) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('is ready when the database and the cluster both answer', async () => {
    expect(await ready()).toEqual({ status: 200, body: { status: 'ready', checks: { database: 'ok', kubernetes: 'ok' } } });
    expect(database.query).toHaveBeenCalledWith('SELECT 1');
    expect(orchestrator.ping).toHaveBeenCalledWith(CHECK_MS);
  });

  it('is not ready, with 503, when the database fails, and says that it was the database', async () => {
    database.query.mockRejectedValue(new Error('connect ECONNREFUSED 10.43.0.12:5432'));

    expect(await ready()).toEqual({
      status: 503,
      body: { status: 'not ready', checks: { database: 'connect ECONNREFUSED 10.43.0.12:5432', kubernetes: 'ok' }, requestId: expect.any(String) },
    });
  });

  it('is not ready when the cluster refuses', async () => {
    orchestrator.ping.mockRejectedValue(new Error('the API server answered 401'));

    expect(await ready()).toMatchObject({ status: 503, body: { status: 'not ready', checks: { database: 'ok', kubernetes: 'the API server answered 401' } } });
  });

  it('is not ready when a check does not answer in time, and answers without waiting for it', async () => {
    database.query.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();

    expect(await ready()).toMatchObject({ status: 503, body: { checks: { database: 'no answer within 2 s', kubernetes: 'ok' } } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(CHECK_MS - 50);
    expect(Date.now() - started).toBeLessThan(CHECK_MS + 1000);
  });

  it('runs both checks together: one slow check does not add to the other', async () => {
    // Each takes 600 ms from when it is asked.
    database.query.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 600)));
    orchestrator.ping.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 600)));
    const started = Date.now();

    expect((await ready()).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1100);
  });
});

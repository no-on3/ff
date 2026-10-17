/**
 * L1: what browsers may send and read across origins (client-readiness plan,
 * P-14), through a real HTTP server with the backend's CORS options. The
 * console calls the API from another origin, so the browser first asks
 * (a preflight) whether its headers are allowed.
 */
import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { RequestIdInterceptor } from './common/request-context';
import { corsOptions } from './cors';

@Controller('probe')
class ProbeController {
  @Get()
  probe() {
    return { ok: true };
  }
}

const CONSOLE = 'http://localhost:5199';

describe('CORS for the console (L1, P-14)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableCors(corsOptions([CONSOLE]));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());

  /** The question a browser asks before a call with these headers. */
  const preflight = (origin: string, headers: string) =>
    fetch(`${baseUrl}/probe`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': headers },
    });

  it('lets the console send its token, the account it acts for and JSON', async () => {
    const res = await preflight(CONSOLE, 'authorization,content-type,x-ff-account');

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE);
    const allowed = res.headers.get('access-control-allow-headers')?.toLowerCase().split(',');
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-ff-account']));
  });

  it("lets the console read each answer's request ID, the one to quote when asking for help", async () => {
    const res = await fetch(`${baseUrl}/probe`, { headers: { origin: CONSOLE } });

    expect(res.headers.get('access-control-allow-origin')).toBe(CONSOLE);
    expect(res.headers.get('access-control-expose-headers')).toBe('x-ff-request-id');
    expect(res.headers.get('x-ff-request-id')).toBeTruthy();
  });

  it('answers another origin without allowing it, so its browser refuses the call', async () => {
    const res = await preflight('http://localhost:5173', 'authorization,x-ff-account');

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

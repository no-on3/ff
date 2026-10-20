/**
 * L1: the app as main.ts sets it up (configureApp), through a real HTTP
 * server. Behind the edge proxy, only the proxies named may say who the caller
 * is, so that the audit log's address and the rate limits by address see the
 * caller and nobody can pose as another address; the API's documents are
 * served only where the settings say, off in production; and text with a NUL
 * character, which PostgreSQL can't store, is refused with a 400 rather than
 * failing at the database with a 500, but for an invocation's input.
 */
import { Body, Controller, Get, INestApplication, Param, Post, Query, Req } from '@nestjs/common';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { configureApp } from './app-setup';
import { REQUEST_ID_HEADER } from './common/request-context';
import { InvokeFunctionDto } from './functions/dto/invoke-function.dto';

class NamedDto {
  @IsString()
  name: string;

  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}

class SearchDto {
  @IsString()
  @IsOptional()
  q?: string;
}

/** What reached the handler, which a refused request never does. */
const handled: unknown[] = [];

@Controller('probe')
class ProbeController {
  @Get('caller')
  caller(@Req() request: { ip?: string }) {
    return { ip: request.ip };
  }

  @Post('named/:id')
  named(@Param('id') id: string, @Body() body: NamedDto) {
    handled.push({ id, ...body });
    return 'ok';
  }

  @Get('search')
  search(@Query() query: SearchDto) {
    handled.push(query);
    return 'ok';
  }

  @Post('invoke')
  invoke(@Body() body: InvokeFunctionDto) {
    handled.push(body.input);
    return body.input;
  }
}

/** An app set up with these settings, listening on a free port; its URL. */
async function appWith(settings: { trustProxy: string[]; apiDocs: boolean }): Promise<{ app: INestApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  const values: Record<string, unknown> = { 'cors.origins': ['https://console.ff.example'], 'http.trustProxy': settings.trustProxy, 'http.apiDocs': settings.apiDocs };
  configureApp(app, { getOrThrow: (key: string) => values[key] } as unknown as ConfigService);
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

const callerOf = async (url: string, forwardedFor?: string) =>
  ((await (await fetch(`${url}/probe/caller`, { headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} })).json()) as { ip: string }).ip;

describe('the app as main.ts sets it up', () => {
  const apps: INestApplication[] = [];
  const open = async (settings: { trustProxy: string[]; apiDocs: boolean }) => {
    const opened = await appWith(settings);
    apps.push(opened.app);
    return opened.url;
  };

  afterAll(() => Promise.all(apps.map((app) => app.close())));

  it('takes the caller from X-Forwarded-For when the proxy in front is one it trusts', async () => {
    const url = await open({ trustProxy: ['127.0.0.1'], apiDocs: false });

    expect(await callerOf(url, '203.0.113.7')).toBe('203.0.113.7');
    // A client that sends the header itself through the proxy: the proxy's own entry, the last, is the caller.
    expect(await callerOf(url, '198.51.100.1, 203.0.113.7')).toBe('203.0.113.7');
  });

  it('believes no X-Forwarded-For without a trusted proxy, or from one it does not trust', async () => {
    const untrusting = await open({ trustProxy: [], apiDocs: false });
    const elsewhere = await open({ trustProxy: ['10.42.0.0/16'], apiDocs: false });

    expect(await callerOf(untrusting, '203.0.113.7')).toMatch(/127\.0\.0\.1$/);
    expect(await callerOf(elsewhere, '203.0.113.7')).toMatch(/127\.0\.0\.1$/);
  });

  it('serves the OpenAPI document and its viewer only when the settings say', async () => {
    const withDocs = await open({ trustProxy: [], apiDocs: true });
    const without = await open({ trustProxy: [], apiDocs: false });

    const document = await fetch(`${withDocs}/api-json`);
    expect([document.status, ((await document.json()) as { paths: object }).paths]).toEqual([200, expect.objectContaining({ '/probe/caller': expect.any(Object) })]);
    expect((await fetch(`${withDocs}/api`)).status).toBe(200);
    expect([(await fetch(`${without}/api-json`)).status, (await fetch(`${without}/api`)).status]).toEqual([404, 404]);
  });

  describe('text with a NUL character (U+0000)', () => {
    const post = (url: string, path: string, body: unknown) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const refusal = async (res: Response) => [res.status, ((await res.json()) as { message: string[] }).message];

    beforeEach(() => void (handled.length = 0));

    it('is refused in a body, at any depth and in a key, naming each place, before the handler runs', async () => {
      const url = await open({ trustProxy: [], apiDocs: false });

      expect(await refusal(await post(url, '/probe/named/1', { name: 'Atelier\u0000Sfax' }))).toEqual([
        400,
        ['name must not contain the NUL character (U+0000)'],
      ]);
      expect(await refusal(await post(url, '/probe/named/1', { name: 'ok', settings: { a: [{ b: 'x\u0000' }], ['k\u0000']: 1 } }))).toEqual([
        400,
        ['settings.a[0].b must not contain the NUL character (U+0000)', 'settings has a key with the NUL character (U+0000)'],
      ]);
      expect(handled).toEqual([]);
    });

    it('is refused in a query and a route parameter, which reach the database too', async () => {
      const url = await open({ trustProxy: [], apiDocs: false });

      expect(await refusal(await fetch(`${url}/probe/search?q=a%00b`))).toEqual([400, ['q must not contain the NUL character (U+0000)']]);
      expect(await refusal(await post(url, '/probe/named/1%00', { name: 'ok' }))).toEqual([400, ['id must not contain the NUL character (U+0000)']]);
      expect(handled).toEqual([]);
    });

    it("passes an invocation's input on whole, as the function gets it, and every other text as it is", async () => {
      const url = await open({ trustProxy: [], apiDocs: false });

      const invoked = await post(url, '/probe/invoke', { input: { text: 'a\u0000b', ['k\u0000']: true } });
      await post(url, '/probe/named/7', { name: 'Atelier Sfax é ✓' });

      expect([invoked.status, await invoked.json()]).toEqual([201, { text: 'a\u0000b', ['k\u0000']: true }]);
      expect(handled).toEqual([{ text: 'a\u0000b', ['k\u0000']: true }, { id: '7', name: 'Atelier Sfax é ✓' }]);
    });
  });

  it("keeps the rest: each answer's request ID, the security headers, and CORS for the console", async () => {
    const url = await open({ trustProxy: [], apiDocs: false });
    const res = await fetch(`${url}/probe/caller`, { headers: { origin: 'https://console.ff.example' } });

    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://console.ff.example');
  });
});

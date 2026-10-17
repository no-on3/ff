/**
 * L1: request IDs and error answers (client-readiness plan, P-10, D4), through
 * a real HTTP server with the backend's global interceptor and filter.
 */
import { BadRequestException, Controller, Get, INestApplication, InternalServerErrorException, Logger } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ApiExceptionFilter } from './api-exception.filter';
import { REQUEST_ID_HEADER, RequestIdInterceptor, currentRequestId } from './request-context';

@Controller('probe')
class ProbeController {
  @Get('id')
  async id() {
    await new Promise((resolve) => setTimeout(resolve, 5)); // the ID must survive asynchronous work
    return { requestId: currentRequestId() };
  }

  @Get('platform')
  platform() {
    throw new Error('namespaces "ff-t-6b86b273ff34" is forbidden: ValidatingAdmissionPolicy ff-controller-scope');
  }

  @Get('mistake')
  mistake() {
    throw new BadRequestException(['memory must not be greater than 1024']);
  }

  @Get('worded')
  worded() {
    throw new InternalServerErrorException('Deploying the function failed because of an internal error (request x).');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('request IDs and error answers (L1, P-10)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let logged: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(() => app.close());

  it('gives every answer its own request ID, which the code serving it sees, even after an await', async () => {
    const first = await fetch(`${baseUrl}/probe/id`);
    const second = await fetch(`${baseUrl}/probe/id`);

    const id = first.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(UUID);
    expect(await first.json()).toEqual({ requestId: id });
    expect(second.headers.get(REQUEST_ID_HEADER)).not.toBe(id);
  });

  it('answers a platform failure with 500, a generic message and the request ID; the details go only to the log', async () => {
    const res = await fetch(`${baseUrl}/probe/platform`);
    const id = res.headers.get(REQUEST_ID_HEADER);
    const text = await res.text();

    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ statusCode: 500, error: 'Internal Server Error', message: `Internal error. Request ID: ${id}`, requestId: id });
    expect(text).not.toContain('ff-t-');
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^Request ${id} \\(GET /probe/platform\\) failed: namespaces "ff-t-6b86b273ff34" is forbidden`)),
      expect.stringContaining('Error: namespaces'),
    );
  });

  it("passes the caller's mistakes through as they are, with the request ID", async () => {
    const res = await fetch(`${baseUrl}/probe/mistake`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['memory must not be greater than 1024'],
      requestId: res.headers.get(REQUEST_ID_HEADER),
    });
    expect(logged).not.toHaveBeenCalled();
  });

  it('keeps a failure the service already worded for the caller', async () => {
    const res = await fetch(`${baseUrl}/probe/worded`);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ message: 'Deploying the function failed because of an internal error (request x).' });
  });

  it('gives an unknown route its request ID too', async () => {
    const res = await fetch(`${baseUrl}/no-such-route`);

    expect(res.status).toBe(404);
    expect((await res.json()).requestId).toMatch(UUID);
  });
});

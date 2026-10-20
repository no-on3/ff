/**
 * L1: the backend's log lines: readable in development, where they used to
 * drop stack traces (they read a `trace` field nest-winston never sets); and
 * one JSON object a line in production, each naming the request it was
 * logged in.
 */
import { PassThrough } from 'node:stream';
import * as winston from 'winston';
import { withRequestContext } from '../common/request-context';
import { consoleLine, jsonLine, logFormat, winstonConfig } from './winston.config';

describe('consoleLine', () => {
  const entry = { timestamp: '2026-10-17T03:00:00.000Z', level: 'error', message: 'boom', context: 'ExceptionsHandler' };

  it("prints the stack trace of an unhandled exception, which Nest passes as nest-winston's stack", () => {
    const line = consoleLine({ ...entry, stack: ['Error: boom\n    at handler (functions.service.ts:42:11)'] });

    expect(line).toBe(
      '2026-10-17T03:00:00.000Z [error] [ExceptionsHandler] boom\nError: boom\n    at handler (functions.service.ts:42:11)',
    );
  });

  it("prints an Error's own stack when one is passed instead of a trace", () => {
    const error = new Error('refused');

    expect(consoleLine({ ...entry, stack: [error] })).toBe(`2026-10-17T03:00:00.000Z [error] [ExceptionsHandler] boom\n${error.stack}`);
  });

  it('prints one line when there is no trace', () => {
    expect(consoleLine({ ...entry, level: 'info', message: 'ready', stack: [undefined] })).toBe(
      '2026-10-17T03:00:00.000Z [info] [ExceptionsHandler] ready',
    );
    expect(consoleLine({ ...entry, level: 'info', message: 'ready' })).toBe('2026-10-17T03:00:00.000Z [info] [ExceptionsHandler] ready');
  });
});

describe('the log format', () => {
  it('is JSON in production and readable lines in development, unless FF_LOG_FORMAT says otherwise', () => {
    expect([logFormat({ NODE_ENV: 'production' }), logFormat({ NODE_ENV: 'development' }), logFormat({})]).toEqual(['json', 'text', 'text']);
    expect([logFormat({ NODE_ENV: 'production', FF_LOG_FORMAT: 'text' }), logFormat({ FF_LOG_FORMAT: 'json' }), logFormat({ NODE_ENV: 'production', FF_LOG_FORMAT: 'xml' })]).toEqual([
      'text',
      'json',
      'json',
    ]);
  });
});

describe('jsonLine', () => {
  const entry = { timestamp: '2026-10-20T03:00:00.000Z', level: 'error', message: 'boom', context: 'ExceptionsHandler' };

  it('gives the time, level, context and message, the request, and the stack as a list', () => {
    expect(JSON.parse(jsonLine({ ...entry, requestId: 'r-1', stack: ['Error: boom\n    at handler (functions.service.ts:42:11)'] }))).toEqual({
      time: '2026-10-20T03:00:00.000Z',
      level: 'error',
      context: 'ExceptionsHandler',
      message: 'boom',
      requestId: 'r-1',
      stack: ['Error: boom\n    at handler (functions.service.ts:42:11)'],
    });
  });

  it('leaves out a request and a stack it has none of, and stays one line', () => {
    const line = jsonLine({ ...entry, level: 'info', message: 'ready\nnow', stack: [undefined] });
    expect(JSON.parse(line)).toEqual({ time: '2026-10-20T03:00:00.000Z', level: 'info', context: 'ExceptionsHandler', message: 'ready\nnow' });
    expect(line).not.toContain('\n');
  });
});

describe("the backend's logger, as main.ts makes it", () => {
  /** A logger with the backend's own formats, writing to a stream the test reads. */
  function logger(format: 'json' | 'text') {
    const options = winstonConfig(format);
    const console = (options.transports as winston.transport[])[0];
    const stream = new PassThrough();
    const lines: string[] = [];
    stream.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
    const log = winston.createLogger({ format: options.format, transports: [new winston.transports.Stream({ stream, format: console.format })] });
    return { log, lines };
  }

  it('writes JSON naming the request the line was logged in, and none outside a request', () => {
    const { log, lines } = logger('json');
    withRequestContext({ requestId: '6f1c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' }, () => log.info('Invoked', { context: 'FunctionsService' }));
    log.warn('Marked 2 invocation(s) LOST', { context: 'UsageService' });

    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { time: expect.any(String), level: 'info', context: 'FunctionsService', message: 'Invoked', requestId: '6f1c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f' },
      { time: expect.any(String), level: 'warn', context: 'UsageService', message: 'Marked 2 invocation(s) LOST' },
    ]);
  });

  it('writes readable lines in development', () => {
    const { log, lines } = logger('text');
    log.info('ready', { context: 'NestApplication' });
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[.*info.*\] \[NestApplication\] ready$/);
  });

  it('writes to stdout only: no file the cluster would lose, or a read-only filesystem refuse', () => {
    for (const format of ['json', 'text'] as const) {
      const transports = winstonConfig(format).transports as winston.transport[];
      expect(transports.map((transport) => transport.constructor.name)).toEqual(['Console']);
    }
  });
});

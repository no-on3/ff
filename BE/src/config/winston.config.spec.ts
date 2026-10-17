/**
 * L1: the console log format (client-readiness plan, P-09). It used to read a
 * `trace` field that nest-winston never sets, so stack traces were dropped.
 */
import { consoleLine } from './winston.config';

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

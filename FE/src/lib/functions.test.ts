import { describe, expect, it } from 'vitest';
import type { Function } from '../services/api';
import { BETA_PLAN } from '../test-fixtures';
import {
  apiErrorMessage,
  changedFields,
  createFailure,
  eventFormatText,
  formatDuration,
  formatMemory,
  historyText,
  parseInvokeInput,
  scalingLimitsError,
  sourceText,
  codeText,
  formatBytes,
} from './functions';

const stored: Function = {
  id: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
  name: 'hello',
  accountId: '000000000001',
  runtime: 'nodejs',
  code: 'export const handler = async () => 1;',
  packageType: 'inline',
  handler: 'function.handler',
  codeSha256: 'zkOT2GnvCo+AmnLChUxKDu+2wfmh+X1GgMJTbbHh5aE=',
  codeSize: 37,
  memory: 128,
  timeout: 5,
  status: 'ACTIVE',
  error: null,
  minInstances: 0,
  maxInstances: 1,
  scaleToZero: true,
  eventFormat: 'lambda',
  metadata: null,
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
};

describe('changedFields', () => {
  it('sends nothing when nothing changed', () => {
    expect(changedFields(stored, stored)).toEqual({});
  });

  it("sends the event format when a function made before is moved to AWS Lambda's event", () => {
    expect(changedFields({ ...stored, eventFormat: 'wrapped' }, { ...stored, eventFormat: 'lambda' })).toEqual({ eventFormat: 'lambda' });
  });

  it('sends only the fields that changed', () => {
    expect(changedFields(stored, { ...stored, name: 'renamed' })).toEqual({ name: 'renamed' });
    expect(changedFields(stored, { ...stored, code: 'v2', memory: 256 })).toEqual({ code: 'v2', memory: 256 });
  });

  it('never sends a field the API refuses, even when the edited copy carries it', () => {
    // The old console sent the whole function back: id, status, createdAt… and got 400.
    const edited = { ...stored, timeout: 30, status: 'ERROR', description: 'x' } as Function & { description: string };

    expect(changedFields(stored, edited)).toEqual({ timeout: 30 });
  });
});

describe('apiErrorMessage', () => {
  const axiosError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  it("uses the API's message, not the client's generic one", () => {
    const error = axiosError(400, { message: 'TypeError: bad input', error: 'Bad Request', statusCode: 400 });

    expect(apiErrorMessage(error)).toBe('TypeError: bad input');
  });

  it('joins a list of validation errors', () => {
    const error = axiosError(400, { message: ['memory must not be greater than 1024', 'name must be a string'] });

    expect(apiErrorMessage(error)).toBe('memory must not be greater than 1024; name must be a string');
  });

  it("falls back to the error's own message when there is no answer, e.g. the API is down", () => {
    expect(apiErrorMessage(new Error('Network Error'))).toBe('Network Error');
  });

  it('passes a message through, and has a default for anything else', () => {
    expect(apiErrorMessage('Function not found')).toBe('Function not found');
    expect(apiErrorMessage(undefined)).toBe('Something went wrong');
  });
});

describe('createFailure', () => {
  const axiosError = (status: number, data: unknown) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });

  it('names the function the API saved when its code failed to load, so the console opens it rather than create it again', () => {
    const error = axiosError(400, {
      statusCode: 400,
      message: 'The function failed to load: Runtime.HandlerNotFound: function.handler is undefined or not exported',
      functionId: stored.id,
    });

    expect(createFailure(error)).toEqual({
      message: 'The function failed to load: Runtime.HandlerNotFound: function.handler is undefined or not exported',
      functionId: stored.id,
    });
  });

  it('names none when nothing was saved: a refused request, or no answer at all', () => {
    expect(createFailure(axiosError(400, { message: ['memory must not be greater than 1024'] }))).toEqual({
      message: 'memory must not be greater than 1024',
    });
    expect(createFailure(new Error('Network Error'))).toEqual({ message: 'Network Error' });
  });

  it("ignores a functionId that isn't an ID", () => {
    expect(createFailure(axiosError(500, { message: 'Internal error', functionId: 42 }))).toEqual({ message: 'Internal error' });
    expect(createFailure(axiosError(500, { message: 'Internal error', functionId: '' }))).toEqual({ message: 'Internal error' });
  });
});

describe('parseInvokeInput', () => {
  it('treats an empty input as {}', () => {
    expect(parseInvokeInput('')).toEqual({ ok: true, input: {} });
    expect(parseInvokeInput('  \n')).toEqual({ ok: true, input: {} });
  });

  it('accepts a JSON object', () => {
    expect(parseInvokeInput('{"name": "Tunis"}')).toEqual({ ok: true, input: { name: 'Tunis' } });
  });

  it.each([
    ['[1, 2]', [1, 2]],
    ['"text"', 'text'],
    ['42', 42],
    ['null', null],
  ])('accepts %s, any JSON value, as AWS Lambda takes a payload', (text, input) => {
    expect(parseInvokeInput(text)).toEqual({ ok: true, input });
  });

  it('refuses text that is not JSON', () => {
    expect(parseInvokeInput('{name: x}')).toEqual({ ok: false, error: 'The input is not valid JSON' });
  });
});

describe('historyText (P-45)', () => {
  it('shows a value the history kept whole as its JSON, indented, a string in quotes', () => {
    expect(historyText({ name: 'FF', n: 1 }, false)).toBe('{\n  "name": "FF",\n  "n": 1\n}');
    expect(historyText('hello', false)).toBe('"hello"');
    expect(historyText(null, false)).toBe('null');
    expect(historyText(undefined, false)).toBe('');
  });

  it('shows the start of the JSON text the history kept of a longer one as it is', () => {
    expect(historyText('{"rows":[{"i":0},{"i":1},{"i', true)).toBe('{"rows":[{"i":0},{"i":1},{"i');
  });
});

describe('formatting', () => {
  it('shows memory in MB as the API sends it, without dividing it again', () => {
    expect(formatMemory(98)).toBe('98 MB');
    expect(formatMemory(null)).toBe('N/A');
    expect(formatMemory(undefined)).toBe('N/A');
  });

  it('shows durations in milliseconds', () => {
    expect(formatDuration(1.087)).toBe('1.09 ms');
    expect(formatDuration(0)).toBe('N/A');
  });
});

describe('scalingLimitsError', () => {
  it('accepts limits the API accepts', () => {
    expect(scalingLimitsError({ minInstances: 0, maxInstances: 3 }, BETA_PLAN)).toBeNull();
    expect(scalingLimitsError({ minInstances: 10, maxInstances: 10 }, BETA_PLAN)).toBeNull();
  });

  it.each([
    [{ minInstances: -1, maxInstances: 3 }, 'Minimum instances must be a whole number from 0 to 10 on the Beta plan'],
    [{ minInstances: 1.5, maxInstances: 3 }, 'Minimum instances must be a whole number from 0 to 10 on the Beta plan'],
    [{ minInstances: 0, maxInstances: 0 }, 'Maximum instances must be a whole number from 1 to 10 on the Beta plan'],
    [{ minInstances: 0, maxInstances: 11 }, 'Maximum instances must be a whole number from 1 to 10 on the Beta plan'],
    [{ minInstances: 4, maxInstances: 3 }, "Minimum instances can't be more than maximum instances"],
  ])('refuses %o', (limits, message) => {
    expect(scalingLimitsError(limits, BETA_PLAN)).toBe(message);
  });

  it("takes the maximum from the account's plan, as the API does (P-15)", () => {
    const pro = { name: 'Pro', limits: { instancesPerFunction: 20 } };

    expect(scalingLimitsError({ minInstances: 0, maxInstances: 15 }, pro)).toBeNull();
    expect(scalingLimitsError({ minInstances: 0, maxInstances: 21 }, pro)).toBe('Maximum instances must be a whole number from 1 to 20 on the Pro plan');
  });
});

describe('eventFormatText', () => {
  it("says what a function's handler gets", () => {
    expect(eventFormatText({ eventFormat: 'lambda' })).toBe("AWS Lambda's event: the input itself");
    expect(eventFormatText({ eventFormat: 'wrapped' })).toMatch(/^FF's original event: the input in event.body/);
  });
});

describe('what brought a call', () => {
  it('is said as the history says it', () => {
    expect((['api', 'url', 'schedule'] as const).map(sourceText)).toEqual(['through the API', 'through its URL', 'by a schedule']);
  });
});

describe('codeText', () => {
  it("says how a function's code comes, its size, and the SHA-256 that names it", () => {
    expect(codeText({ packageType: 'inline', codeSize: 41, codeSha256: 'LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE=' })).toBe(
      'Inline code, 41 bytes, SHA-256 LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE=',
    );
    expect(codeText({ packageType: 'zip', codeSize: 4_351_234, codeSha256: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=' })).toBe(
      'A package, 4.4 MB, SHA-256 n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
    );
  });

  it('shows sizes as the API states its limits: bytes, KB, MB', () => {
    expect([formatBytes(999), formatBytes(1000), formatBytes(921_600), formatBytes(52_428_800)]).toEqual(['999 bytes', '1.0 KB', '921.6 KB', '52.4 MB']);
  });
});

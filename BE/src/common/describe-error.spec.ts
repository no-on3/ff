import { describeError } from './describe-error';

describe('describeError', () => {
  it('uses the message of an ordinary error', () => {
    expect(describeError(new Error('relation "functions" does not exist'))).toBe('relation "functions" does not exist');
  });

  it('lists the causes of an AggregateError that has no message (a refused connection)', () => {
    const refused = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')],
      '',
    );

    expect(describeError(refused)).toBe('connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('keeps the message of an AggregateError, and lists each distinct cause once', () => {
    const error = new AggregateError([new Error('timeout'), new Error('timeout')], 'all attempts failed');

    expect(describeError(error)).toBe('all attempts failed: timeout');
  });

  it('falls back to the error code, then to the error name', () => {
    expect(describeError(Object.assign(new Error(''), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(describeError(new TypeError(''))).toBe('TypeError');
  });

  it('describes values that are not errors', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(42)).toBe('42');
  });
});

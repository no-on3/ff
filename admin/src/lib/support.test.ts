import { describe, expect, it } from 'vitest';
import { TRUNCATED, callValue, foundIn, lookDialog, milliseconds, outcome, searchSummary } from './support';

describe("a look at a customer's data", () => {
  it("says what it shows, and that the account's owners see it in their audit log, with the reason", () => {
    const owners = "The account's owners see in their audit log that FF looked, with your reason.";
    expect(lookDialog({ kind: 'code' }, 'mailer')).toEqual({
      title: 'View the code?',
      body: `This shows the code of mailer: the customer's data. ${owners}`,
      confirmLabel: 'View',
    });
    expect(lookDialog({ kind: 'call', callId: 'c-1' }, 'mailer').body).toBe(`This shows what call c-1 sent and got back, and its error: the customer's data. ${owners}`);
    expect(lookDialog({ kind: 'logs', callId: 'c-1' }, 'mailer').body).toBe(`This shows the log lines of call c-1: the customer's data. ${owners}`);
    expect(lookDialog({ kind: 'logs' }, 'mailer')).toMatchObject({ title: 'View the logs?', body: `This shows the last hour's log lines of mailer: the customer's data. ${owners}` });
  });
});

describe('the search, to read', () => {
  const results = (accounts: number, functions: number, calls: number) => ({
    accounts: Array(accounts).fill({}),
    functions: Array(functions).fill({}),
    calls: Array(calls).fill({}),
  });

  it('counts what it found, one or more of each, and says when nothing matched', () => {
    expect(searchSummary(results(1, 2, 0), 'amira')).toBe('1 account, 2 functions');
    expect(searchSummary(results(0, 0, 1), 'c-1')).toBe('1 call');
    expect(searchSummary(results(0, 0, 0), 'nobody')).toBe('No account, function or call matches "nobody".');
  });

  it('says where a call was found: the history, or only its usage record', () => {
    expect([foundIn({ inHistory: true }), foundIn({ inHistory: false })]).toEqual(['the history', 'its usage record only: the history no longer keeps it']);
  });
});

describe('a call, to read', () => {
  it("gives its status, with a failure's type", () => {
    expect([outcome({ status: 'COMPLETED', errorType: null }), outcome({ status: 'ERROR', errorType: 'ValidationError' })]).toEqual(['COMPLETED', 'ERROR · ValidationError']);
  });

  it('gives its duration in milliseconds, to two places', () => {
    expect([milliseconds(1.0912), milliseconds(2000)]).toEqual(['1.09 ms', '2,000 ms']);
  });

  it('shows a value as indented JSON, or the start the history kept, as it is', () => {
    expect(callValue({ email: 'a@b.tn' }, false)).toBe('{\n  "email": "a@b.tn"\n}');
    expect(callValue('{"rows":[1,2', true)).toBe('{"rows":[1,2');
    expect(callValue('plain', false)).toBe('"plain"');
    expect(TRUNCATED).toBe('Truncated: the history keeps the first 64 KiB.');
  });
});

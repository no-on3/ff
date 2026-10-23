import { AttemptOutcome, EventEnd, LAMBDA_RETRY_POLICY, afterAttempt, attemptsOf, onClaim } from './async-invoke';

const SENT = new Date('2026-10-23T10:00:00Z');
const at = (seconds: number) => new Date(SENT.getTime() + seconds * 1000);
const none = { failures: 0, throttles: 0, settled: 0 };

describe('asynchronous calls, as AWS Lambda retries them (L1)', () => {
  describe('what an event keeps of its attempts', () => {
    it('starts with none, and reads only whole counts back', () => {
      expect(attemptsOf(null)).toEqual(none);
      expect(attemptsOf({ failures: 1, throttles: 3, settled: 4, other: 'kept elsewhere' })).toEqual({ failures: 1, throttles: 3, settled: 4 });
      expect(attemptsOf({ failures: '1', throttles: 1.5 })).toEqual(none);
    });
  });

  describe('after an attempt', () => {
    it('ends an event its function ran', () => {
      expect(afterAttempt(none, AttemptOutcome.SUCCESS, SENT, at(1), LAMBDA_RETRY_POLICY)).toEqual({ end: EventEnd.SUCCEEDED, attempts: { ...none, settled: 1 } });
    });

    it("retries a function's failure a minute later, then two minutes later, then drops the event: Lambda's two retries", () => {
      const first = afterAttempt(none, AttemptOutcome.FUNCTION_ERROR, SENT, at(1), LAMBDA_RETRY_POLICY);
      expect(first).toEqual({ retryAt: at(61), attempts: { failures: 1, throttles: 0, settled: 1 } });

      const second = afterAttempt((first as { attempts: typeof none }).attempts, AttemptOutcome.FUNCTION_ERROR, SENT, at(62), LAMBDA_RETRY_POLICY);
      expect(second).toEqual({ retryAt: at(182), attempts: { failures: 2, throttles: 0, settled: 2 } });

      const third = afterAttempt((second as { attempts: typeof none }).attempts, AttemptOutcome.FUNCTION_ERROR, SENT, at(183), LAMBDA_RETRY_POLICY);
      expect(third).toEqual({ end: EventEnd.RETRIES_EXHAUSTED, attempts: { failures: 3, throttles: 0, settled: 3 } });
    });

    it('retries a throttle, or a call FF could not make, after 1, 2, 4… seconds, up to five minutes, none of them counted as a retry', () => {
      let attempts = none;
      const waits: number[] = [];
      for (let n = 0; n < 11; n++) {
        const outcome = n % 2 ? AttemptOutcome.SYSTEM_ERROR : AttemptOutcome.THROTTLED;
        const next = afterAttempt(attempts, outcome, SENT, at(10), LAMBDA_RETRY_POLICY) as { retryAt: Date; attempts: typeof none };
        waits.push((next.retryAt.getTime() - at(10).getTime()) / 1000);
        attempts = next.attempts;
      }

      expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300]);
      expect(attempts).toEqual({ failures: 0, throttles: 11, settled: 11 });
    });

    it('drops an event whose next attempt would come past its maximum age, six hours by default', () => {
      const late = at(6 * 3600 - 30);

      expect(afterAttempt(none, AttemptOutcome.FUNCTION_ERROR, SENT, late, LAMBDA_RETRY_POLICY)).toMatchObject({ end: EventEnd.TOO_OLD });
      expect(afterAttempt(none, AttemptOutcome.THROTTLED, SENT, late, LAMBDA_RETRY_POLICY)).toMatchObject({ retryAt: at(6 * 3600 - 29) });
    });

    it("follows the function's own policy: no retries, a shorter age", () => {
      const policy = { maximumRetryAttempts: 0, maximumEventAgeSeconds: 60 };

      expect(afterAttempt(none, AttemptOutcome.FUNCTION_ERROR, SENT, at(1), policy)).toMatchObject({ end: EventEnd.RETRIES_EXHAUSTED });
      expect(afterAttempt(none, AttemptOutcome.THROTTLED, SENT, at(59.5), policy)).toMatchObject({ end: EventEnd.TOO_OLD });
    });
  });

  describe('a claim, before its attempt', () => {
    it('runs a new event, and one whose claims all kept their outcome', () => {
      expect(onClaim(none, 1, SENT, at(0), LAMBDA_RETRY_POLICY)).toEqual({ run: none });
      expect(onClaim({ failures: 1, throttles: 2, settled: 3 }, 4, SENT, at(300), LAMBDA_RETRY_POLICY)).toEqual({ run: { failures: 1, throttles: 2, settled: 3 } });
    });

    it('counts each claim that kept no outcome, lost with its backend, as a failed attempt', () => {
      expect(onClaim(none, 2, SENT, at(600), LAMBDA_RETRY_POLICY)).toEqual({ run: { failures: 1, throttles: 0, settled: 1 } });
      expect(onClaim({ failures: 1, throttles: 0, settled: 1 }, 3, SENT, at(900), LAMBDA_RETRY_POLICY)).toEqual({ run: { failures: 2, throttles: 0, settled: 2 } });
    });

    it('drops an event whose lost attempts used its retries, and one past its age', () => {
      expect(onClaim({ failures: 2, throttles: 0, settled: 2 }, 4, SENT, at(1200), LAMBDA_RETRY_POLICY)).toEqual({
        end: EventEnd.RETRIES_EXHAUSTED,
        attempts: { failures: 3, throttles: 0, settled: 3 },
      });
      expect(onClaim(none, 1, SENT, at(6 * 3600 + 1), LAMBDA_RETRY_POLICY)).toMatchObject({ end: EventEnd.TOO_OLD });
    });
  });
});

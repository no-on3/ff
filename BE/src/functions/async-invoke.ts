/**
 * Asynchronous calls, as AWS Lambda makes them (ADR 0010): what is kept of an
 * event's attempts, and when its next attempt comes, or why it has none.
 */
import { LATEST } from './qualifier';

/** Lambda's limit on an asynchronous call's event, once serialized: 1 MB. */
export const MAX_ASYNC_INPUT_BYTES = 1024 * 1024;

/** Lambda's waits before an event's retries, after its function failed: a minute, then two. */
export const RETRY_DELAYS_SECONDS = [60, 120] as const;

/** The backoff after a throttle or FF's own failure, as Lambda's: from a second, doubling each time, to five minutes. */
export const BACKOFF_FIRST_SECONDS = 1;
export const BACKOFF_MAX_SECONDS = 300;

/** How many times an event is retried after its function failed, and how long it is kept: Lambda's defaults, and its maximums. */
export interface RetryPolicy {
  maximumRetryAttempts: number;
  maximumEventAgeSeconds: number;
}
export const LAMBDA_RETRY_POLICY: RetryPolicy = { maximumRetryAttempts: 2, maximumEventAgeSeconds: 6 * 3600 };

/** How long an event is kept past the longest age a function may give it, so that the worker sees it past its age; the store deletes it then. */
export const EXPIRY_GRACE_SECONDS = 3600;

/** What an event's queue keeps of its attempts beside it. */
export interface EventAttempts {
  /** Attempts its function failed, timeouts and attempts lost with their backend included: past the retries, the event is dropped. */
  failures: number;
  /** Attempts throttled, or that FF couldn't make: each waits longer than the last, until the event's age is up. */
  throttles: number;
  /** Claims whose outcome was kept: a claim with none was lost with its backend. */
  settled: number;
}

/** What is kept of an event's attempts, from its message's attributes: none before its first. */
export function attemptsOf(attributes: Record<string, unknown> | null): EventAttempts {
  const count = (name: string) => (Number.isInteger(attributes?.[name]) ? (attributes?.[name] as number) : 0);
  return { failures: count('failures'), throttles: count('throttles'), settled: count('settled') };
}

/** How an attempt ended, as its retries see it. */
export enum AttemptOutcome {
  SUCCESS = 'success',
  /** The function failed: it threw, timed out, or couldn't load. */
  FUNCTION_ERROR = 'function-error',
  /** No instance could take it in time. */
  THROTTLED = 'throttled',
  /** FF couldn't make the call: its own failure, or the account or the function unable to take one for now. */
  SYSTEM_ERROR = 'system-error',
}

/** Why an event has no attempt left. */
export enum EventEnd {
  SUCCEEDED = 'succeeded',
  RETRIES_EXHAUSTED = 'retries-exhausted',
  TOO_OLD = 'too-old',
  FUNCTION_GONE = 'function-gone',
  /** The version or the alias the call named was deleted since: no attempt can run what it named. */
  QUALIFIER_GONE = 'qualifier-gone',
}

/** The ends a destination is told of, as Lambda's conditions name them; an event whose function, version or alias is gone has none. */
export type RecordedEnd = Exclude<EventEnd, EventEnd.FUNCTION_GONE | EventEnd.QUALIFIER_GONE>;

/** Whether a destination is told of the end. */
export const isRecorded = (end: EventEnd): end is RecordedEnd => end !== EventEnd.FUNCTION_GONE && end !== EventEnd.QUALIFIER_GONE;

/** What its queue keeps beside a call that named a version or an alias: what it named; none for $LATEST. */
export function qualifierOf(attributes: Record<string, unknown> | null): string | undefined {
  return typeof attributes?.qualifier === 'string' ? attributes.qualifier : undefined;
}

/** How an attempt answered, as a destination's record gives it: Lambda's status, and the function's output or the error. */
export interface AttemptResponse {
  statusCode: number;
  /** "Unhandled" when the function failed, as Lambda says it. */
  functionError?: 'Unhandled';
  /** The version the attempt was for, as Lambda's ExecutedVersion: its number, or $LATEST, as a response kept before versions ran is read. */
  executedVersion?: string;
  payload: unknown;
}

/** The longest error message an event keeps of its last failed attempt, for its record. */
const KEPT_ERROR_CHARS = 4096;

/** A failed attempt's answer, as its event keeps it for its record: the error's type and the start of its message. */
export function keptResponse(response: AttemptResponse): AttemptResponse {
  const payload = response.payload as { errorType?: unknown; errorMessage?: unknown } | null;
  const text = (value: unknown, otherwise: string) => (typeof value === 'string' ? value : otherwise);
  return {
    ...response,
    payload: { errorType: text(payload?.errorType, 'Error'), errorMessage: text(payload?.errorMessage, '').slice(0, KEPT_ERROR_CHARS) },
  };
}

/** The last failed attempt's answer that an event kept, if any. */
export function lastResponseOf(attributes: Record<string, unknown> | null): AttemptResponse | undefined {
  const kept = attributes?.lastResponse as AttemptResponse | undefined;
  return kept && Number.isInteger(kept.statusCode) ? kept : undefined;
}

/** Why a record is sent, as Lambda's condition names it. */
const CONDITIONS: Record<RecordedEnd, string> = {
  [EventEnd.SUCCEEDED]: 'Success',
  [EventEnd.RETRIES_EXHAUSTED]: 'RetriesExhausted',
  [EventEnd.TOO_OLD]: 'EventAgeExceeded',
};

/**
 * A call's record, as AWS Lambda sends a destination one: the request, with
 * the function's ARN qualified by what the call named, $LATEST by default;
 * why it is sent; the event; and the last attempt's answer, when one ran,
 * with the version that ran it.
 */
export function invocationRecord(call: {
  requestId: string;
  functionArn: string;
  qualifier?: string;
  end: RecordedEnd;
  approximateInvokeCount: number;
  requestPayload: unknown;
  response?: AttemptResponse;
  timestamp: Date;
}): Record<string, unknown> {
  const { response } = call;
  return {
    version: '1.0',
    timestamp: call.timestamp.toISOString(),
    requestContext: {
      requestId: call.requestId,
      functionArn: `${call.functionArn}:${call.qualifier ?? LATEST}`,
      condition: CONDITIONS[call.end],
      approximateInvokeCount: call.approximateInvokeCount,
    },
    requestPayload: call.requestPayload,
    ...(response
      ? {
          responseContext: {
            statusCode: response.statusCode,
            executedVersion: response.executedVersion ?? LATEST,
            ...(response.functionError ? { functionError: response.functionError } : {}),
          },
          responsePayload: response.payload,
        }
      : {}),
  };
}

/** What comes after an attempt: the event's end, or its next attempt. */
export type Settlement = { end: EventEnd; attempts: EventAttempts } | { retryAt: Date; attempts: EventAttempts };

/** An event's age at `now`, in seconds. */
const ageSeconds = (sentAt: Date, now: Date) => (now.getTime() - sentAt.getTime()) / 1000;

/**
 * A claim of an event, before its attempt: the claims before it that kept no
 * outcome were lost with their backend, and each counts as an attempt its
 * function failed, since nobody waits for the call to say it was lost. An
 * event past its age, or whose lost attempts used its retries, has none left.
 */
export function onClaim(attempts: EventAttempts, receiveCount: number, sentAt: Date, now: Date, policy: RetryPolicy): Settlement | { run: EventAttempts } {
  const lost = Math.max(0, receiveCount - 1 - attempts.settled);
  const counted = { ...attempts, failures: attempts.failures + lost, settled: attempts.settled + lost };
  if (ageSeconds(sentAt, now) > policy.maximumEventAgeSeconds) return { end: EventEnd.TOO_OLD, attempts: counted };
  if (counted.failures > policy.maximumRetryAttempts) return { end: EventEnd.RETRIES_EXHAUSTED, attempts: counted };
  return { run: counted };
}

/**
 * After an attempt that ended at `now`: success ends the event; a failure of
 * the function retries it after a minute, then two, as many times as the
 * policy allows; a throttle or FF's own failure retries it with a backoff
 * from a second to five minutes. A retry that would come past the event's
 * age doesn't: the event ends there.
 */
export function afterAttempt(attempts: EventAttempts, outcome: AttemptOutcome, sentAt: Date, now: Date, policy: RetryPolicy): Settlement {
  const settled = { ...attempts, settled: attempts.settled + 1 };
  if (outcome === AttemptOutcome.SUCCESS) return { end: EventEnd.SUCCEEDED, attempts: settled };
  let delaySeconds: number;
  if (outcome === AttemptOutcome.FUNCTION_ERROR) {
    settled.failures += 1;
    if (settled.failures > policy.maximumRetryAttempts) return { end: EventEnd.RETRIES_EXHAUSTED, attempts: settled };
    delaySeconds = RETRY_DELAYS_SECONDS[Math.min(settled.failures, RETRY_DELAYS_SECONDS.length) - 1];
  } else {
    settled.throttles += 1;
    delaySeconds = Math.min(BACKOFF_FIRST_SECONDS * 2 ** (settled.throttles - 1), BACKOFF_MAX_SECONDS);
  }
  const retryAt = new Date(now.getTime() + delaySeconds * 1000);
  if (ageSeconds(sentAt, retryAt) > policy.maximumEventAgeSeconds) return { end: EventEnd.TOO_OLD, attempts: settled };
  return { retryAt, attempts: settled };
}

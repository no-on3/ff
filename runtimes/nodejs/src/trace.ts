/**
 * A call's trace, as AWS X-Ray writes its ID and AWS Lambda gives a call its _X_AMZN_TRACE_ID: the backend's, which
 * X-FF-Trace-Id names, else a new one, for a call that came without, as `ff local`'s do.
 */
import { randomBytes } from 'node:crypto';

const TRACE_ID = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

/** The call's trace: the ID given, in X-Ray's format, else a new one, 1-<the time, 8 hex digits>-<24 random ones>. */
export function traceIdOf(given: string | undefined, now = Date.now()): string {
  if (given !== undefined && TRACE_ID.test(given)) return given;
  const seconds = Math.floor(now / 1000).toString(16).padStart(8, '0').slice(-8);
  return `1-${seconds}-${randomBytes(12).toString('hex')}`;
}

/**
 * _X_AMZN_TRACE_ID for a call in the trace, as Lambda sets it for a call X-Ray doesn't sample: the trace's Root, a
 * Parent of the call's own, and Sampled=0. The AWS SDKs pass the whole of it on in X-Amzn-Trace-Id.
 */
export function lambdaTraceHeader(traceId: string): string {
  return `Root=${traceId};Parent=${randomBytes(8).toString('hex')};Sampled=0`;
}

import { Injectable } from '@nestjs/common';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { IncomingHttpHeaders } from 'node:http';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { currentRequestId } from '../common/request-context';
import { MAX_ASYNC_INPUT_BYTES } from '../functions/async-invoke';
import { AsyncInvocationsService } from '../functions/async-invocations.service';
import { InvocationType } from '../functions/dto/invoke-function.dto';
import { InvocationSource } from '../functions/entities/function-invocation.entity';
import { Function, FunctionStatus } from '../functions/entities/function.entity';
import { CallOutcome, CallTarget, FunctionsService } from '../functions/functions.service';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { refusals } from '../monitoring/operator-metrics';
import { FunctionRuntimeError, FunctionThrottledError } from '../orchestrator/orchestrator.errors';
import { countInvocation } from '../plans/rate-limits';
import {
  LambdaError,
  invalidParameterValue,
  invalidRequestContent,
  requestEntityTooLarge,
  resourceConflict,
  serviceException,
  tooManyRequests,
} from './lambda-error';
import { statesOf } from './lambda-functions';
import { INVOKE_FUNCTION, LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, qualifiedLookup } from './lambda-operations';

/** Lambda's limit on a ClientContext, in base64. */
export const CLIENT_CONTEXT_BYTES = 3583;

const INVOCATION_TYPES: readonly InvocationType[] = Object.values(InvocationType);
const LOG_TYPES = ['None', 'Tail'] as const;

/** A header's one value: the first, when it came twice. */
const headerOf = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The payload, any JSON value, as Lambda takes it; {} for none, as Lambda gives a function called without one. */
function payloadOf(body: Buffer): unknown {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch (error) {
    throw invalidRequestContent(`Could not parse request body into json: ${describeError(error)}`);
  }
}

/**
 * The caller's ClientContext, X-Amz-Client-Context, as Lambda takes it: the base64 of a JSON object, its 3583 bytes at
 * most. Passed on as sent, which both runtimes read.
 */
function clientContextOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  if (header.length > CLIENT_CONTEXT_BYTES) {
    throw invalidParameterValue(`ClientContext must be at most ${CLIENT_CONTEXT_BYTES} bytes of base64, not ${header.length}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    value = undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequestContent('Client context must be a valid Base64-encoded JSON object.');
  return header;
}

/** One of the values Lambda takes for a header, or its default; refused, naming them, otherwise. */
function oneOf<T extends string>(headers: IncomingHttpHeaders, name: string, field: string, values: readonly T[], fallback: T): T {
  const value = headerOf(headers, name) ?? fallback;
  const known = values.find((candidate) => candidate === value);
  if (known === undefined) throw invalidParameterValue(`${field} must be ${values.join(', ')}, not ${value}.`);
  return known;
}

/**
 * Lambda's Invoke (ADR 0014), over FF's calls: the function's payload as sent, any JSON value;
 * what the path or the Qualifier names runs, $LATEST, a version, or an alias's version.
 * - RequestResponse waits for the call: 200 with the function's answer as its runtime sent it; a function that threw,
 *   timed out or failed to load answers 200 too, X-Amz-Function-Error: Unhandled and Lambda's error document, as on
 *   Lambda. X-Amz-Executed-Version names what ran, and with X-Amz-Log-Type: Tail, X-Amz-Log-Result holds the call's
 *   last 4 KB of log, which the runtime gives back. X-Amz-Client-Context reaches the handler's context.
 * - Event keeps the call in the function's queue, its 1 MB at most, and answers 202; DryRun checks it, and answers 204.
 * - Refused as Lambda refuses: a function not Active, its state named; past the plan's invocations per second, or
 *   with no instance of the function free, TooManyRequestsException with its Reason; without credit, 429 too, saying
 *   so. Each call counts against the plan's invocations per second, with FF's API's and the URLs'.
 */
@Injectable()
export class LambdaInvoke implements LambdaHandlers {
  constructor(
    private readonly functions: FunctionsService,
    private readonly asyncInvocations: AsyncInvocationsService,
    private readonly credit: CreditService,
    private readonly refused: RefusedInvocationsService,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    Invoke: (call, caller) => this.invoke(call, caller),
  };

  private async invoke({ body, headers }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = namedFunction(caller);
    const qualifier = caller.named?.qualifier;
    const type = oneOf(headers, 'x-amz-invocation-type', 'InvocationType', INVOCATION_TYPES, InvocationType.REQUEST_RESPONSE);
    const logTail = oneOf(headers, 'x-amz-log-type', 'LogType', LOG_TYPES, 'None') === 'Tail';
    const clientContext = clientContextOf(headerOf(headers, 'x-amz-client-context'));
    if (type === InvocationType.EVENT && body.length > MAX_ASYNC_INPUT_BYTES) throw requestEntityTooLarge(MAX_ASYNC_INPUT_BYTES, INVOKE_FUNCTION);
    const payload = payloadOf(body);
    const target = await this.targetOf(function_, qualifier, caller);
    await this.count(function_, caller);
    if (type === InvocationType.DRY_RUN) return { status: 204 };
    // What a version runs was frozen when it was published: it runs whatever $LATEST's state, as a rollback needs.
    if (!target.version && function_.status !== FunctionStatus.ACTIVE) {
      throw resourceConflict(`The operation cannot be performed at this time. The function is currently in the following state: ${statesOf(function_).State}`);
    }
    if (type === InvocationType.EVENT) {
      // The queue checks the account's credit, as for the API's asynchronous calls.
      await inCredit(this.asyncInvocations.queue(caller.accountId, function_.id, payload, qualifier));
      return { status: 202 };
    }
    await inCredit(this.credit.admit(caller.accountId));
    // Lambda passes a ClientContext on to a call it waits for, and to no other.
    const asks = { logTail, ...(clientContext !== undefined ? { clientContext } : {}) };
    const outcome = await this.functions.call(function_, payload, { source: InvocationSource.API, requestId: currentRequestId(), target, asks });
    return answerOf(outcome, target);
  }

  /** What the qualifier names; a version or an alias the function hasn't as Lambda says it, the function's ARN with it. */
  private targetOf(function_: Function, qualifier: string | undefined, caller: LambdaCaller): Promise<CallTarget> {
    return qualifiedLookup(this.functions.callTarget(function_, qualifier), caller, function_, qualifier);
  }

  /** The call counts against the plan's invocations per second, with the API's invokes and the URLs' calls. */
  private async count(function_: Function, caller: LambdaCaller): Promise<void> {
    const { name, limits } = caller.plan;
    const wait = await countInvocation(this.throttler, caller.accountId, limits.invokesPerSecond);
    if (wait === undefined) return;
    // A refused call reached no function and has no usage record: the Throttles metric counts it here, as the API's.
    this.refused.count(caller.accountId, function_.id);
    refusals.inc({ reason: 'rate_limit' });
    throw tooManyRequests(`Rate exceeded: the ${name} plan allows ${limits.invokesPerSecond} invocations per second.`, wait);
  }
}

/** What checks the account's credit, as the API's invoke does: once it ran out, Lambda's 429, its message saying so. */
async function inCredit<T>(checked: Promise<T>): Promise<T> {
  try {
    return await checked;
  } catch (error) {
    if (!(error instanceof InsufficientCreditException)) throw error;
    const { message } = error.getResponse() as { message: string };
    throw new LambdaError(429, 'TooManyRequestsException', message.replace(/^InsufficientCreditException: /, "The account's credit ran out. "));
  }
}

/**
 * A call's answer, as Lambda's: the function's answer, or its error as the call's outcome, 200 both; no instance free,
 * 429, its Reason the function's instances, which its maxInstances bounds as Lambda's reserved concurrency does; the
 * platform's failure, ServiceException, its details in the server's log with the request's ID.
 */
function answerOf(outcome: CallOutcome, target: CallTarget): LambdaAnswer {
  const headers: Record<string, string> = {
    'x-amz-executed-version': target.version ? String(target.version.version) : '$LATEST',
    ...(outcome.logResult !== undefined ? { 'x-amz-log-result': outcome.logResult } : {}),
  };
  if (outcome.ok) return { status: 200, body: Buffer.from(outcome.outputJson ?? JSON.stringify(outcome.output ?? null), 'utf8'), headers };
  const { error } = outcome;
  if (error instanceof FunctionRuntimeError) {
    return { status: 200, document: { errorType: error.errorType, errorMessage: error.message }, headers: { ...headers, 'x-amz-function-error': 'Unhandled' } };
  }
  if (error instanceof FunctionThrottledError) {
    throw new LambdaError(429, 'TooManyRequestsException', error.message, { Reason: 'ReservedFunctionConcurrentInvocationLimitExceeded' });
  }
  throw serviceException();
}

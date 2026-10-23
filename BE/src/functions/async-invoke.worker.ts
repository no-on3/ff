import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { withRequestContext } from '../common/request-context';
import { FunctionRuntimeError, FunctionThrottledError } from '../orchestrator/orchestrator.errors';
import { ClaimedEvent, QueueStore } from '../queues/queue-store';
import {
  AttemptOutcome,
  AttemptResponse,
  EXPIRY_GRACE_SECONDS,
  EventEnd,
  LAMBDA_RETRY_POLICY,
  MAX_ASYNC_INPUT_BYTES,
  Settlement,
  afterAttempt,
  attemptsOf,
  invocationRecord,
  keptResponse,
  lastResponseOf,
  onClaim,
} from './async-invoke';
import { InvocationSource } from './entities/function-invocation.entity';
import { Function, FunctionStatus } from './entities/function.entity';
import { AsyncSettings, EventInvokeConfigService } from './event-invoke-config.service';
import { FunctionsService } from './functions.service';

/** Why an event ended without succeeding, as the server log says it. */
const ENDS: Record<Exclude<EventEnd, EventEnd.SUCCEEDED>, string> = {
  [EventEnd.RETRIES_EXHAUSTED]: 'its retries are used up',
  [EventEnd.TOO_OLD]: 'it reached its maximum age',
  [EventEnd.FUNCTION_GONE]: 'its function is gone',
};

/** An attempt's outcome, and how it answered, for the event's record. */
interface Attempted {
  outcome: AttemptOutcome;
  response: AttemptResponse;
}

/**
 * Runs functions' asynchronous calls (ADR 0010). Every
 * FF_ASYNC_INTERVAL_SECONDS, it claims the events due, as many as it has room
 * for (FF_ASYNC_CONCURRENCY at once), each hidden from other backends for its
 * lease, and makes each attempt as the API's invoke makes a call: the
 * function ACTIVE, the account active with credit, the record and the bill,
 * the history's source `async` and its attempt, under the event's request ID.
 * The plan's rate was counted when the call came. Then the event is deleted,
 * or put back for its next attempt as Lambda retries, by the function's own
 * settings, else Lambda's defaults (async-invoke.ts, EventInvokeConfigService).
 * An event that ends hands its record, Lambda's, to the destination its
 * function names for how it ended, in the transaction that deletes it. A
 * backend that stops during an attempt leaves its event to come back when its
 * lease ends, the attempt counted as failed.
 */
@Injectable()
export class AsyncInvokeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsyncInvokeWorker.name);
  private readonly intervalSeconds: number;
  private readonly concurrency: number;
  private readonly coldStartSeconds: number;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** The attempts under way, which a test may wait for. */
  private readonly running = new Set<Promise<void>>();

  constructor(
    config: ConfigService,
    private readonly queues: QueueStore,
    private readonly functions: FunctionsService,
    private readonly credit: CreditService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly configs: EventInvokeConfigService,
  ) {
    const settings = config.getOrThrow<{ intervalSeconds: number; concurrency: number }>('asyncInvoke');
    this.intervalSeconds = settings.intervalSeconds;
    this.concurrency = settings.concurrency;
    this.coldStartSeconds = config.get<number>('kubernetes.readyTimeoutSeconds', 90);
  }

  onModuleInit(): void {
    if (this.intervalSeconds <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick: the events due claimed and their attempts started, within the room left. A tick still claiming makes the next one wait its turn. */
  async tick(now = new Date()): Promise<number> {
    const room = this.concurrency - this.running.size;
    if (this.ticking || room <= 0) return 0;
    this.ticking = true;
    try {
      const events = await this.queues.claimEvents(room, now, this.coldStartSeconds);
      for (const event of events) {
        const started = this.attempt(event, now).finally(() => this.running.delete(started));
        this.running.add(started);
      }
      return events.length;
    } catch (error) {
      this.logger.error(`Could not claim the asynchronous calls due: ${describeError(error)}`);
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /** Waits for the attempts under way. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** One claim of an event: its attempt, unless it has none left, then what comes after. A failure here leaves the event to its lease. */
  private async attempt(event: ClaimedEvent, claimedAt: Date): Promise<void> {
    // The claim's clock, which a test may set, as the attempt goes on.
    const offset = claimedAt.getTime() - Date.now();
    const now = () => new Date(Date.now() + offset);
    try {
      await withRequestContext({ requestId: event.requestId }, async () => {
        const fn = await this.functionOf(event);
        if (!fn) return this.settle(event, { end: EventEnd.FUNCTION_GONE, attempts: attemptsOf(event.attributes) });
        const settings = await this.configs.settingsFor(fn.id);
        const claim = onClaim(attemptsOf(event.attributes), event.receiveCount, event.sentAt, claimedAt, settings.policy);
        if (!('run' in claim)) return this.settle(event, claim, { fn, settings, response: lastResponseOf(event.attributes), at: now() });
        const attempted = await this.run(fn, event);
        const settlement = afterAttempt(claim.run, attempted.outcome, event.sentAt, now(), settings.policy);
        await this.settle(event, settlement, { fn, settings, response: attempted.response, at: now() });
      });
    } catch (error) {
      this.logger.error(
        `The attempt of asynchronous call ${event.requestId} of function ${event.functionId} failed; it comes back when its lease ends: ${describeError(error)}`,
      );
    }
  }

  /** The event's function, unless it is gone. */
  private async functionOf(event: ClaimedEvent): Promise<Function | undefined> {
    try {
      return await this.functions.findOne(event.accountId, event.functionId);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  /** The call, as the API's invoke makes one; FF's own failure when the function or the account can't take one now. */
  private async run(fn: Function, event: ClaimedEvent): Promise<Attempted> {
    const waits = (why: string): Attempted => {
      this.logger.log(`Asynchronous call ${event.requestId} of function ${event.functionId} waits: ${why}`);
      return { outcome: AttemptOutcome.SYSTEM_ERROR, response: { statusCode: 500, payload: { errorType: 'ServiceException', errorMessage: `FF couldn't make the call: ${why}` } } };
    };
    if (fn.status !== FunctionStatus.ACTIVE) return waits('the function is not ACTIVE');
    const account = await this.accounts.findOne({ where: { id: event.accountId }, select: { id: true, status: true } });
    if (!account || account.status !== AccountStatus.ACTIVE) return waits('the account is not active');
    try {
      await this.credit.admit(event.accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) return waits("the account's credit has run out");
      throw error;
    }
    const outcome = await this.functions.call(fn, JSON.parse(event.body) as unknown, {
      source: InvocationSource.ASYNC,
      requestId: event.requestId,
      attempt: event.receiveCount,
    });
    if (outcome.ok) return { outcome: AttemptOutcome.SUCCESS, response: { statusCode: 200, payload: outcome.output } };
    if (outcome.error instanceof FunctionThrottledError) {
      return { outcome: AttemptOutcome.THROTTLED, response: { statusCode: 429, payload: { errorType: 'TooManyRequestsException', errorMessage: outcome.visible } } };
    }
    if (outcome.error instanceof FunctionRuntimeError) {
      const failed = outcome.error;
      return {
        outcome: AttemptOutcome.FUNCTION_ERROR,
        response: { statusCode: 200, functionError: 'Unhandled', payload: { errorType: failed.errorType, errorMessage: failed.message } },
      };
    }
    return { outcome: AttemptOutcome.SYSTEM_ERROR, response: { statusCode: 500, payload: { errorType: 'ServiceException', errorMessage: outcome.visible } } };
  }

  /**
   * The event deleted, its record handed to its destination, or put back for
   * its next attempt with its last failure kept for that record; unless its
   * lease ended and another claim has it.
   */
  private async settle(
    event: ClaimedEvent,
    settlement: Settlement,
    context?: { fn: Function; settings: AsyncSettings; response?: AttemptResponse; at: Date },
  ): Promise<void> {
    let kept: boolean;
    if (!('end' in settlement)) {
      // Only a failure is retried: its answer is kept for the record, should the event end at a later claim.
      const lastResponse = context?.response ? keptResponse(context.response) : undefined;
      kept = await this.queues.retryEvent(event, settlement.retryAt, { ...event.attributes, ...settlement.attempts, ...(lastResponse ? { lastResponse } : {}) });
    } else {
      const destination = context && settlement.end !== EventEnd.FUNCTION_GONE ? (settlement.end === EventEnd.SUCCEEDED ? context.settings.onSuccess : context.settings.onFailure) : null;
      kept = destination && context ? await this.deliver(event, settlement.end as Exclude<EventEnd, EventEnd.FUNCTION_GONE>, destination, context) : await this.queues.deleteEvent(event);
    }
    if (!kept) {
      this.logger.warn(`The attempt of asynchronous call ${event.requestId} ended after its lease: another claim has the event, which stands`);
      return;
    }
    if ('end' in settlement && settlement.end !== EventEnd.SUCCEEDED) {
      this.logger.warn(`Asynchronous call ${event.requestId} of function ${event.functionId} was dropped: ${ENDS[settlement.end]}`);
    }
  }

  /** The event deleted and its record handed to the destination as an asynchronous call of its own; a record that can't be delivered is said, and the event deleted all the same. */
  private async deliver(
    event: ClaimedEvent,
    end: Exclude<EventEnd, EventEnd.FUNCTION_GONE>,
    destination: string,
    context: { fn: Function; response?: AttemptResponse; at: Date },
  ): Promise<boolean> {
    const record = invocationRecord({
      requestId: event.requestId,
      functionArn: this.configs.arnOf(context.fn),
      end,
      approximateInvokeCount: event.receiveCount,
      requestPayload: JSON.parse(event.body) as unknown,
      response: context.response,
      timestamp: context.at,
    });
    const body = JSON.stringify(record);
    const target = await this.configs.destinationFunction(event.accountId, destination);
    const undelivered = !target
      ? `its destination ${destination} is no function of the account any more`
      : Buffer.byteLength(body) > MAX_ASYNC_INPUT_BYTES
        ? `its record is ${Buffer.byteLength(body)} bytes, over an asynchronous call's ${MAX_ASYNC_INPUT_BYTES}`
        : undefined;
    if (!target || undelivered) {
      this.logger.warn(`The record of asynchronous call ${event.requestId} of function ${event.functionId} was not delivered: ${undelivered}`);
      return this.queues.deleteEvent(event);
    }
    const expiresAt = new Date(context.at.getTime() + (LAMBDA_RETRY_POLICY.maximumEventAgeSeconds + EXPIRY_GRACE_SECONDS) * 1000);
    return this.queues.deleteEventAndSend(event, target, randomUUID(), body, expiresAt);
  }
}

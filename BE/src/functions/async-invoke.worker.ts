import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { withRequestContext } from '../common/request-context';
import { FunctionRuntimeError, FunctionThrottledError } from '../orchestrator/orchestrator.errors';
import { ClaimedEvent, QueueStore } from '../queues/queue-store';
import { AttemptOutcome, EventAttempts, EventEnd, LAMBDA_RETRY_POLICY, Settlement, afterAttempt, attemptsOf, onClaim } from './async-invoke';
import { InvocationSource } from './entities/function-invocation.entity';
import { Function, FunctionStatus } from './entities/function.entity';
import { FunctionsService } from './functions.service';

/** Why an event ended without succeeding, as the server log says it. */
const ENDS: Record<Exclude<EventEnd, EventEnd.SUCCEEDED>, string> = {
  [EventEnd.RETRIES_EXHAUSTED]: 'its retries are used up',
  [EventEnd.TOO_OLD]: 'it reached its maximum age',
  [EventEnd.FUNCTION_GONE]: 'its function is gone',
};

/**
 * Runs functions' asynchronous calls (ADR 0010). Every
 * FF_ASYNC_INTERVAL_SECONDS, it claims the events due, as many as it has room
 * for (FF_ASYNC_CONCURRENCY at once), each hidden from other backends for its
 * lease, and makes each attempt as the API's invoke makes a call: the
 * function ACTIVE, the account active with credit, the record and the bill,
 * the history's source `async` and its attempt, under the event's request ID.
 * The plan's rate was counted when the call came. Then the event is deleted,
 * or put back for its next attempt as Lambda retries (async-invoke.ts). A
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
        const claim = onClaim(attemptsOf(event.attributes), event.receiveCount, event.sentAt, claimedAt, LAMBDA_RETRY_POLICY);
        await this.settle(event, 'run' in claim ? await this.run(event, claim.run, now) : claim);
      });
    } catch (error) {
      this.logger.error(
        `The attempt of asynchronous call ${event.requestId} of function ${event.functionId} failed; it comes back when its lease ends: ${describeError(error)}`,
      );
    }
  }

  /** The attempt, and when the next one comes, or why there is none. */
  private async run(event: ClaimedEvent, attempts: EventAttempts, now: () => Date): Promise<Settlement> {
    const outcome = await this.outcomeOf(event);
    if (outcome === undefined) return { end: EventEnd.FUNCTION_GONE, attempts };
    return afterAttempt(attempts, outcome, event.sentAt, now(), LAMBDA_RETRY_POLICY);
  }

  /** The call, as the API's invoke makes one; FF's own failure when the function or the account can't take one now; undefined when the function is gone. */
  private async outcomeOf(event: ClaimedEvent): Promise<AttemptOutcome | undefined> {
    let function_: Function;
    try {
      function_ = await this.functions.findOne(event.accountId, event.functionId);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
    const waits = (why: string) => {
      this.logger.log(`Asynchronous call ${event.requestId} of function ${event.functionId} waits: ${why}`);
      return AttemptOutcome.SYSTEM_ERROR;
    };
    if (function_.status !== FunctionStatus.ACTIVE) return waits('the function is not ACTIVE');
    const account = await this.accounts.findOne({ where: { id: event.accountId }, select: { id: true, status: true } });
    if (!account || account.status !== AccountStatus.ACTIVE) return waits('the account is not active');
    try {
      await this.credit.admit(event.accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) return waits("the account's credit has run out");
      throw error;
    }
    const outcome = await this.functions.call(function_, JSON.parse(event.body) as unknown, {
      source: InvocationSource.ASYNC,
      requestId: event.requestId,
      attempt: event.receiveCount,
    });
    if (outcome.ok) return AttemptOutcome.SUCCESS;
    if (outcome.error instanceof FunctionThrottledError) return AttemptOutcome.THROTTLED;
    if (outcome.error instanceof FunctionRuntimeError) return AttemptOutcome.FUNCTION_ERROR;
    return AttemptOutcome.SYSTEM_ERROR;
  }

  /** The event deleted, or put back for its next attempt, unless its lease ended and another claim has it. */
  private async settle(event: ClaimedEvent, settlement: Settlement): Promise<void> {
    const kept =
      'end' in settlement
        ? await this.queues.deleteEvent(event)
        : await this.queues.retryEvent(event, settlement.retryAt, { ...event.attributes, ...settlement.attempts });
    if (!kept) {
      this.logger.warn(`The attempt of asynchronous call ${event.requestId} ended after its lease: another claim has the event, which stands`);
      return;
    }
    if ('end' in settlement && settlement.end !== EventEnd.SUCCEEDED) {
      this.logger.warn(`Asynchronous call ${event.requestId} of function ${event.functionId} was dropped: ${ENDS[settlement.end]}`);
    }
  }
}

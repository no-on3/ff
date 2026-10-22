import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { withRequestContext } from '../common/request-context';
import { InvocationSource, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { EventFormat, Function, FunctionStatus } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { refusals } from '../monitoring/operator-metrics';
import { PlansService } from '../plans/plans.service';
import { countInvocation } from '../plans/rate-limits';
import { nextRun, parseScheduleExpression } from './schedule-expression';
import { Schedule } from './schedule.entity';
import { ruleName, scheduledEvent } from './scheduled-event';

/** The most due schedules one tick takes; the rest wait for the next tick, a few seconds later. */
const BATCH = 50;

/** A due schedule, taken: when it was due, and the request ID its run has. */
interface Due {
  schedule: Schedule;
  dueAt: Date;
  requestId: string;
}

/**
 * Runs the schedules. Every FF_SCHEDULER_INTERVAL_SECONDS, it takes the
 * enabled schedules due, with FOR UPDATE SKIP LOCKED, moves each to its next
 * run and commits, then runs them: so a run happens at most once, whatever
 * the number of backends, and a backend stopped between the commit and the
 * call loses that run. A late schedule runs once, then follows its expression
 * from now. A run is a call like any other (the account's state, its credit,
 * the plan's rate, the record, the bill), with the Scheduled Event or the
 * schedule's input; one that can't be made is skipped, and the schedule says
 * why. A run isn't retried.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly intervalSeconds: number;
  private readonly region: string;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  /** The runs under way, which a test, or a stopping backend, may wait for. */
  private readonly running = new Set<Promise<void>>();

  constructor(
    config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly functions: FunctionsService,
    private readonly credit: CreditService,
    private readonly plans: PlansService,
    private readonly refused: RefusedInvocationsService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
  ) {
    this.intervalSeconds = config.getOrThrow<number>('schedules.intervalSeconds');
    this.region = config.getOrThrow<string>('schedules.region');
  }

  onModuleInit(): void {
    if (this.intervalSeconds <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One tick: the due schedules taken and started. A tick still taking them makes the next one wait its turn. */
  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = await this.takeDue(now);
      for (const run of due) {
        const started = this.run(run).finally(() => this.running.delete(started));
        this.running.add(started);
      }
      return due.length;
    } catch (error) {
      this.logger.error(`The scheduler could not take the due schedules: ${describeError(error)}`);
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /** Waits for the runs under way. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /** Takes the due schedules, each moved to its next run, in one transaction: once committed, no other backend takes them. */
  private takeDue(now: Date): Promise<Due[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager
        .getRepository(Schedule)
        .createQueryBuilder('schedule')
        .where('schedule.enabled = true AND schedule.nextRunAt <= :now', { now })
        .orderBy('schedule.nextRunAt', 'ASC')
        .limit(BATCH)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();
      const due: Due[] = [];
      for (const schedule of rows) {
        const dueAt = schedule.nextRunAt as Date;
        const requestId = randomUUID();
        let next: Date | null;
        try {
          // After now, not after when it was due: a late schedule runs once, then follows its expression.
          next = nextRun(parseScheduleExpression(schedule.expression), now, schedule.anchorAt ?? dueAt);
        } catch (error) {
          this.logger.error(`Schedule ${schedule.id} has an expression it can't run, and is disabled: ${describeError(error)}`);
          await manager.update(Schedule, { id: schedule.id }, { enabled: false, nextRunAt: null, lastOutcome: 'skipped: its expression is not valid' });
          continue;
        }
        await manager.update(Schedule, { id: schedule.id }, { nextRunAt: next, lastRunAt: dueAt, lastRequestId: requestId, lastOutcome: 'running' });
        due.push({ schedule, dueAt, requestId });
      }
      return due;
    });
  }

  /** One run, and its outcome on the schedule, unless a later run has replaced it. */
  private async run({ schedule, dueAt, requestId }: Due): Promise<void> {
    let outcome: string;
    try {
      outcome = await withRequestContext({ requestId }, () => this.call(schedule, dueAt, requestId));
    } catch (error) {
      this.logger.error(`The run of schedule ${schedule.id} failed (request ${requestId}): ${describeError(error)}`);
      outcome = 'skipped: an internal error';
    }
    await this.dataSource
      .getRepository(Schedule)
      .update({ id: schedule.id, lastRequestId: requestId }, { lastOutcome: outcome })
      .catch((error: unknown) => this.logger.warn(`Could not record the outcome of schedule ${schedule.id}'s run: ${describeError(error)}`));
  }

  /** The call, as the API's invoke makes one; why it was skipped when it can't be made. */
  private async call(schedule: Schedule, dueAt: Date, requestId: string): Promise<string> {
    let function_: Function;
    try {
      function_ = await this.functions.findOne(schedule.accountId, schedule.functionId);
    } catch (error) {
      if (error instanceof NotFoundException) return 'skipped: the function is gone';
      throw error;
    }
    if (function_.status !== FunctionStatus.ACTIVE) return 'skipped: the function is not ACTIVE';
    if (function_.eventFormat !== EventFormat.LAMBDA) return "skipped: the function takes FF's original wrapped event";
    const account = await this.accounts.findOne({ where: { id: schedule.accountId }, select: { id: true, status: true, planId: true } });
    if (!account || account.status !== AccountStatus.ACTIVE) return 'skipped: the account is not active';
    try {
      await this.credit.admit(schedule.accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) return "skipped: the account's credit has run out";
      throw error;
    }
    const plan = await this.plans.get(account.planId);
    if ((await countInvocation(this.throttler, schedule.accountId, plan.limits.invokesPerSecond)) !== undefined) {
      this.refused.count(schedule.accountId, schedule.functionId);
      refusals.inc({ reason: 'rate_limit' });
      return "skipped: over the plan's invocations per second";
    }
    const event =
      schedule.input ??
      scheduledEvent({ id: requestId, account: schedule.accountId, time: dueAt, region: this.region, rule: ruleName(function_.name, schedule.name) });
    const outcome = await this.functions.call(function_, event, { source: InvocationSource.SCHEDULE, requestId });
    if (outcome.ok) return 'success';
    const status = outcome.invocation.status;
    return status === InvocationStatus.TIMEOUT ? 'timeout' : status === InvocationStatus.THROTTLED ? 'throttled' : 'error';
  }
}

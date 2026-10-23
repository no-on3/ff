import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectThrottlerStorage, ThrottlerStorage } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { InsufficientCreditException } from '../billing/credit-policy';
import { CreditService } from '../billing/credit.service';
import { describeError } from '../common/describe-error';
import { EXPIRY_GRACE_SECONDS, LAMBDA_RETRY_POLICY } from '../functions/async-invoke';
import { EventFormat, Function, FunctionStatus } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { RefusedInvocationsService } from '../metrics/refused-invocations.service';
import { refusals } from '../monitoring/operator-metrics';
import { PlansService } from '../plans/plans.service';
import { countInvocation } from '../plans/rate-limits';
import { QueueStore } from '../queues/queue-store';
import { nextRun, parseScheduleExpression } from './schedule-expression';
import { Schedule } from './schedule.entity';
import { ruleName, scheduledEvent } from './scheduled-event';

/** The most due schedules one tick takes; the rest wait for the next tick, a few seconds later. */
const BATCH = 50;

/** A megabyte, as the plans count what messages hold. */
const MB = 1024 * 1024;

/** What its function's queue keeps beside a schedule's run: that it is the schedule's, which its worker says on the schedule. */
export const SCHEDULE_ORIGIN = 'schedule';

/** A run that can be made: its function, and the event it sends. */
interface Admitted {
  fn: Function;
  event: unknown;
}

/**
 * Runs the schedules. Every FF_SCHEDULER_INTERVAL_SECONDS, it takes the
 * enabled schedules due, with FOR UPDATE SKIP LOCKED, and in one transaction
 * moves each to its next run and keeps its run in the function's queue, as an
 * asynchronous call: so a run is taken once, whatever the number of backends,
 * and none is lost when a backend stops, as EventBridge Scheduler hands its
 * runs to Lambda. The asynchronous calls' worker then runs it (ADR 0010),
 * retried by the function's settings, else Lambda's, and says each attempt's
 * outcome on the schedule. A late schedule runs once, then follows its
 * expression from now. A run is checked as a call is when it is taken (the
 * account's state, its credit, the plan's rate and its room for messages); one
 * that can't be made is skipped, and the schedule says why.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly intervalSeconds: number;
  private readonly region: string;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly functions: FunctionsService,
    private readonly credit: CreditService,
    private readonly plans: PlansService,
    private readonly refused: RefusedInvocationsService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectThrottlerStorage() private readonly throttler: ThrottlerStorage,
    private readonly queues: QueueStore,
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

  /** One tick: the due schedules taken, each moved on with its run queued or skipped; how many. A tick still taking them makes the next one wait its turn. */
  async tick(now = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      return await this.takeDue(now);
    } catch (error) {
      this.logger.error(`The scheduler could not take the due schedules: ${describeError(error)}`);
      return 0;
    } finally {
      this.ticking = false;
    }
  }

  /** Takes the due schedules, each moved to its next run with its run queued or skipped, in one transaction: once committed, no other backend takes them. */
  private takeDue(now: Date): Promise<number> {
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
      for (const schedule of rows) await this.take(manager, schedule, now);
      return rows.length;
    });
  }

  /** A due schedule: moved to its next run, its run queued in its function's queue, or skipped with the reason on it. */
  private async take(manager: EntityManager, schedule: Schedule, now: Date): Promise<void> {
    const dueAt = schedule.nextRunAt as Date;
    const requestId = randomUUID();
    let next: Date | null;
    try {
      // After now, not after when it was due: a late schedule runs once, then follows its expression.
      next = nextRun(parseScheduleExpression(schedule.expression), now, schedule.anchorAt ?? dueAt);
    } catch (error) {
      this.logger.error(`Schedule ${schedule.id} has an expression it can't run, and is disabled: ${describeError(error)}`);
      await manager.update(Schedule, { id: schedule.id }, { enabled: false, nextRunAt: null, lastOutcome: 'skipped: its expression is not valid' });
      return;
    }
    let admitted: Admitted | string;
    try {
      admitted = await this.admit(schedule, dueAt, requestId);
    } catch (error) {
      this.logger.error(`The run of schedule ${schedule.id} could not be made (request ${requestId}): ${describeError(error)}`);
      admitted = 'skipped: an internal error';
    }
    await manager.update(
      Schedule,
      { id: schedule.id },
      { nextRunAt: next, lastRunAt: dueAt, lastRequestId: requestId, lastOutcome: typeof admitted === 'string' ? admitted : 'running' },
    );
    if (typeof admitted === 'string') return;
    const expiresAt = new Date(now.getTime() + (LAMBDA_RETRY_POLICY.maximumEventAgeSeconds + EXPIRY_GRACE_SECONDS) * 1000);
    await this.queues.sendEvent(admitted.fn, requestId, JSON.stringify(admitted.event), expiresAt, {
      manager,
      attributes: { origin: SCHEDULE_ORIGIN, scheduleId: schedule.id },
    });
  }

  /** The run, checked as the API's invoke checks a call: its function and event, or why it is skipped. */
  private async admit(schedule: Schedule, dueAt: Date, requestId: string): Promise<Admitted | string> {
    let fn: Function;
    try {
      fn = await this.functions.findOne(schedule.accountId, schedule.functionId);
    } catch (error) {
      if (error instanceof NotFoundException) return 'skipped: the function is gone';
      throw error;
    }
    if (fn.status !== FunctionStatus.ACTIVE) return 'skipped: the function is not ACTIVE';
    if (fn.eventFormat !== EventFormat.LAMBDA) return "skipped: the function takes FF's original wrapped event";
    const account = await this.accounts.findOne({ where: { id: schedule.accountId }, select: { id: true, status: true, planId: true } });
    if (!account || account.status !== AccountStatus.ACTIVE) return 'skipped: the account is not active';
    try {
      await this.credit.admit(schedule.accountId);
    } catch (error) {
      if (error instanceof InsufficientCreditException) return "skipped: the account's credit has run out";
      throw error;
    }
    const plan = await this.plans.get(account.planId);
    const event =
      schedule.input ?? scheduledEvent({ id: requestId, account: schedule.accountId, time: dueAt, region: this.region, rule: ruleName(fn.name, schedule.name) });
    if ((await this.queues.accountBytes(schedule.accountId)) + Buffer.byteLength(JSON.stringify(event)) > plan.limits.queueStorageMb * MB) {
      return `skipped: the account's messages hold ${plan.limits.queueStorageMb} MB together, the ${plan.name} plan's limit`;
    }
    if ((await countInvocation(this.throttler, schedule.accountId, plan.limits.invokesPerSecond)) !== undefined) {
      this.refused.count(schedule.accountId, schedule.functionId);
      refusals.inc({ reason: 'rate_limit' });
      return "skipped: over the plan's invocations per second";
    }
    return { fn, event };
  }
}

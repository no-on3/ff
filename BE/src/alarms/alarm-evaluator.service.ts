import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In } from 'typeorm';
import { BillingService } from '../billing/billing.service';
import { describeError } from '../common/describe-error';
import { Period } from '../metrics/customer-metrics';
import { CustomerMetricsService } from '../metrics/customer-metrics.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Alarm } from './alarm.entity';
import { alarmMail } from './alarm-mail';
import { AlarmState, BILLING_METRICS, DATABASE_METRICS, Evaluation, databaseDatapointsOf, datapointsOf, evaluate, evaluationWindow, notifies, stateReason } from './alarm-rules';
import { alarmChanges, alarmEvaluations } from '../monitoring/operator-metrics';

/** The most alarms one backend takes at once. */
export const CLAIM_BATCH = 100;

/**
 * Evaluates every alarm, every FF_ALARM_INTERVAL_SECONDS (a minute): its
 * last N whole periods, each once it has been over FF_ALARM_SETTLE_SECONDS,
 * or the account's money as it is. A backend takes the alarms due with FOR
 * UPDATE SKIP LOCKED, so that two never evaluate one at once. A change of
 * state is recorded with its reason, and told, into ALARM and out of it,
 * through the notifications, in the same transaction.
 */
@Injectable()
export class AlarmEvaluator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlarmEvaluator.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: CustomerMetricsService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const { intervalSeconds } = this.config.getOrThrow<{ intervalSeconds: number }>('alarms');
    this.timer = setInterval(() => void this.tick(), intervalSeconds * 1000);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** One round: every alarm due, evaluated; how many. A round still running is waited for, never doubled. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return this.running;
    this.running = this.round(now).finally(() => (this.running = undefined));
    return this.running;
  }

  private async round(now: Date): Promise<number> {
    let done = 0;
    for (;;) {
      let alarms: Alarm[];
      try {
        alarms = await this.claim(now);
      } catch (error) {
        this.logger.error(`Could not take the alarms due: ${describeError(error)}`);
        return done;
      }
      for (const alarm of alarms) {
        try {
          await this.evaluateOne(alarm, now);
        } catch (error) {
          this.logger.error(`Could not evaluate alarm ${alarm.id} of account ${alarm.accountId}: ${describeError(error)}`);
        }
      }
      done += alarms.length;
      if (alarms.length < CLAIM_BATCH) return done;
    }
  }

  /** The alarms not evaluated in this round yet, marked as evaluated now, so that no other backend takes them. */
  private async claim(now: Date): Promise<Alarm[]> {
    const { intervalSeconds } = this.config.getOrThrow<{ intervalSeconds: number }>('alarms');
    const [rows] = await this.dataSource.query<[Array<{ id: string }>, number]>(
      `UPDATE "alarms" SET "evaluated_at" = $1
        WHERE "id" IN (SELECT "id" FROM "alarms"
                        WHERE "evaluated_at" IS NULL OR "evaluated_at" <= $1::timestamptz - make_interval(secs => $2)
                        ORDER BY "evaluated_at" NULLS FIRST LIMIT $3 FOR UPDATE SKIP LOCKED)
        RETURNING "id"`,
      // A little short of the interval, so that a round that starts a moment early still takes them.
      [now, Math.max(intervalSeconds - 5, 0), CLAIM_BATCH],
    );
    if (rows.length === 0) return [];
    return this.dataSource.getRepository(Alarm).find({ where: { id: In(rows.map((row) => row.id)) }, relations: { account: true, function: true, database: true } });
  }

  /** The alarm's datapoints, oldest first: its periods' values, a database's hours, or the account's money as it is. */
  private async datapoints(alarm: Alarm, now: Date): Promise<Array<number | null>> {
    if (BILLING_METRICS.includes(alarm.metric)) {
      const view = await this.billing.balance(alarm.accountId, now);
      return [Number(alarm.metric === 'Balance' ? view.balance : view.charged)];
    }
    const { settleSeconds } = this.config.getOrThrow<{ settleSeconds: number }>('alarms');
    const window = { ...evaluationWindow(alarm, now, settleSeconds), period: alarm.period as Period };
    if (DATABASE_METRICS.includes(alarm.metric)) {
      return databaseDatapointsOf(await this.metrics.forDatabase(alarm.accountId, alarm.databaseId as string, window), alarm.metric, alarm.statistic);
    }
    const view = alarm.functionId ? await this.metrics.forFunction(alarm.accountId, alarm.functionId, window) : await this.metrics.forAccount(alarm.accountId, window);
    return datapointsOf(view, alarm.metric, alarm.statistic);
  }

  private async evaluateOne(alarm: Alarm, now: Date): Promise<void> {
    const evaluation = evaluate(alarm, await this.datapoints(alarm, now), alarm.state);
    alarmEvaluations.inc();
    const reason = stateReason(alarm, evaluation);
    if (evaluation.state === alarm.state) {
      await this.dataSource.getRepository(Alarm).update({ id: alarm.id }, { stateReason: reason, stateReasonData: evaluation });
      return;
    }
    await this.dataSource.transaction(async (manager) => {
      // Changed only from the state it was read in: an alarm replaced meanwhile is judged again at the next round.
      const { affected } = await manager.getRepository(Alarm).update(
        { id: alarm.id, state: alarm.state },
        { state: evaluation.state, stateReason: reason, stateReasonData: evaluation, stateChangedAt: now },
      );
      if (affected) alarmChanges.inc({ state: evaluation.state });
      if (!affected || !notifies(alarm.state, evaluation.state)) return;
      await this.tell(alarm, alarm.state, evaluation, reason, now, manager);
    });
  }

  /** Into ALARM, or out of it: the owners' e-mail and the webhooks the alarm names. */
  private async tell(alarm: Alarm, from: AlarmState, evaluation: Evaluation, reason: string, now: Date, manager: EntityManager): Promise<void> {
    const { actions } = alarm;
    if (!actions.email && actions.webhookUrls.length === 0) return;
    const { consoleUrl } = this.config.getOrThrow<{ consoleUrl: string }>('mail');
    const account = { id: alarm.accountId, name: alarm.account?.name ?? alarm.accountId };
    const change = { account, alarm, functionName: alarm.function?.name ?? null, databaseName: alarm.database?.name ?? null, from, to: evaluation.state, evaluation, at: now, consoleUrl };
    await this.notifications.notify(
      {
        accountId: alarm.accountId,
        kind: 'alarm',
        data: {
          alarm: {
            id: alarm.id,
            name: alarm.name,
            functionId: alarm.functionId,
            databaseId: alarm.databaseId,
            metric: alarm.metric,
            statistic: alarm.statistic,
            period: alarm.period,
            comparison: alarm.comparison,
            threshold: alarm.threshold,
            evaluationPeriods: alarm.evaluationPeriods,
            datapointsToAlarm: alarm.datapointsToAlarm,
          },
          previousState: from,
          state: evaluation.state,
          reason,
          latest: evaluation.latest,
          datapoints: evaluation.datapoints,
          at: now.toISOString(),
        },
        email: actions.email ? (language) => alarmMail(change, language) : undefined,
        webhookUrls: actions.webhookUrls,
      },
      manager,
    );
  }
}

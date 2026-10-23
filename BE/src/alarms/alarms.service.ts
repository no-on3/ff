import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Database } from '../databases/database.entity';
import { Function } from '../functions/entities/function.entity';
import { webhookUrlProblem } from '../notifications/webhook-target';
import { Bucket } from '../storage/bucket.entity';
import { Alarm } from './alarm.entity';
import { AlarmRule, MAX_ALARMS, alarmProblem } from './alarm-rules';
import { AlarmDto, AlarmView } from './alarms.dto';

export const alarmView = (alarm: Alarm): AlarmView => ({
  id: alarm.id,
  name: alarm.name,
  functionId: alarm.functionId,
  databaseId: alarm.databaseId,
  bucketName: alarm.bucket?.name ?? null,
  metric: alarm.metric,
  statistic: alarm.statistic,
  period: alarm.period,
  comparison: alarm.comparison,
  threshold: alarm.threshold,
  evaluationPeriods: alarm.evaluationPeriods,
  datapointsToAlarm: alarm.datapointsToAlarm,
  treatMissingData: alarm.treatMissingData,
  actions: alarm.actions,
  state: alarm.state,
  stateReason: alarm.stateReason,
  stateChangedAt: alarm.stateChangedAt,
  evaluatedAt: alarm.evaluatedAt,
  createdAt: alarm.createdAt,
  updatedAt: alarm.updatedAt,
});

/** What an alarm is: the rule, its name and its actions; a bucket by its ID, once its name is found. */
type AlarmDefinition = Pick<
  Alarm,
  | 'name'
  | 'functionId'
  | 'databaseId'
  | 'bucketId'
  | 'metric'
  | 'statistic'
  | 'period'
  | 'comparison'
  | 'threshold'
  | 'evaluationPeriods'
  | 'datapointsToAlarm'
  | 'treatMissingData'
  | 'actions'
>;

/** An alarm's definition, from the request, and the bucket it names; its ID comes once it is found (AlarmsService.check). */
function definition(dto: AlarmDto): AlarmDefinition {
  return {
    name: dto.name.trim(),
    functionId: dto.functionId ?? null,
    databaseId: dto.databaseId ?? null,
    bucketId: null,
    metric: dto.metric,
    statistic: dto.statistic,
    period: dto.period,
    comparison: dto.comparison,
    threshold: dto.threshold,
    evaluationPeriods: dto.evaluationPeriods,
    datapointsToAlarm: dto.datapointsToAlarm,
    treatMissingData: dto.treatMissingData ?? 'missing',
    actions: { email: dto.actions.email, webhookUrls: dto.actions.webhookUrls.map((url) => url.trim()) },
  };
}

/** The account's alarms: GET, POST, PUT and DELETE /alarms. Each change is in its audit log. */
@Injectable()
export class AlarmsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async list(accountId: string): Promise<AlarmView[]> {
    const alarms = await this.dataSource.getRepository(Alarm).find({ where: { accountId }, relations: { bucket: true }, order: { createdAt: 'ASC', id: 'ASC' } });
    return alarms.map(alarmView);
  }

  async get(accountId: string, id: string): Promise<AlarmView> {
    return alarmView(await this.find(this.dataSource.manager, accountId, id));
  }

  /** A new alarm, judged at the next evaluation; at most 50 per account. */
  async create(accountId: string, dto: AlarmDto): Promise<AlarmView> {
    const alarm = definition(dto);
    return this.dataSource.transaction(async (manager) => {
      alarm.bucketId = await this.check(manager, accountId, alarm, dto.bucketName ?? null);
      // The account's row, locked: two creates at once can't both take the last place.
      await manager.query(`SELECT 1 FROM "accounts" WHERE "id" = $1 FOR UPDATE`, [accountId]);
      if ((await manager.getRepository(Alarm).countBy({ accountId })) >= MAX_ALARMS) throw new BadRequestException(`An account has at most ${MAX_ALARMS} alarms`);
      const saved = await manager.getRepository(Alarm).save({ ...alarm, accountId });
      await this.audit.record({ accountId, action: 'alarm.create', resource: `alarm:${saved.id}`, details: { ...alarm } }, manager);
      return alarmView(await this.find(manager, accountId, saved.id));
    });
  }

  /** The alarm, replaced; its state stays until the next evaluation, which comes at once. */
  async update(accountId: string, id: string, dto: AlarmDto): Promise<AlarmView> {
    const alarm = definition(dto);
    return this.dataSource.transaction(async (manager) => {
      const before = await this.find(manager, accountId, id, true);
      alarm.bucketId = await this.check(manager, accountId, alarm, dto.bucketName ?? null);
      await manager.getRepository(Alarm).update({ id, accountId }, { ...alarm, evaluatedAt: null });
      const changes = Object.fromEntries(
        Object.entries(alarm)
          .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof Alarm]))
          .map(([key, value]) => [key, { from: before[key as keyof Alarm], to: value }]),
      );
      await this.audit.record({ accountId, action: 'alarm.update', resource: `alarm:${id}`, details: { name: alarm.name, changes } }, manager);
      return alarmView(await this.find(manager, accountId, id));
    });
  }

  async remove(accountId: string, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const alarm = await this.find(manager, accountId, id, true);
      await manager.getRepository(Alarm).delete({ id, accountId });
      await this.audit.record({ accountId, action: 'alarm.delete', resource: `alarm:${id}`, details: { name: alarm.name, metric: alarm.metric } }, manager);
    });
  }

  /** The account's alarm, with its bucket; locked, without it, as a row locked can't be read with an outer join. */
  private async find(manager: EntityManager, accountId: string, id: string, lock = false): Promise<Alarm> {
    const alarm = await manager
      .getRepository(Alarm)
      .findOne({ where: { id, accountId }, ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : { relations: { bucket: true } }) });
    if (!alarm) throw new NotFoundException(`Alarm ${id} not found`);
    return alarm;
  }

  /**
   * The rule's own problems, a function, database or bucket the account
   * doesn't have, and a webhook URL the notifications wouldn't take. Answers
   * the ID of the bucket it names, if it names one.
   */
  private async check(manager: EntityManager, accountId: string, alarm: AlarmRule & { actions: { webhookUrls: string[] } }, bucketName: string | null): Promise<string | null> {
    const problem = alarmProblem({ ...alarm, bucketId: bucketName }) ?? alarm.actions.webhookUrls.map(webhookUrlProblem).find(Boolean);
    if (problem) throw new BadRequestException(problem);
    if (alarm.functionId && !(await manager.getRepository(Function).existsBy({ id: alarm.functionId, accountId }))) {
      throw new NotFoundException(`Function with ID ${alarm.functionId} not found`);
    }
    if (alarm.databaseId && !(await manager.getRepository(Database).existsBy({ id: alarm.databaseId, accountId }))) {
      throw new NotFoundException(`Database ${alarm.databaseId} not found`);
    }
    if (!bucketName) return null;
    const bucket = await manager.getRepository(Bucket).findOne({ where: { name: bucketName, accountId }, select: { id: true } });
    if (!bucket) throw new NotFoundException(`The account has no bucket ${bucketName}`);
    return bucket.id;
  }
}

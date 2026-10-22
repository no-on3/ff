import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { EventFormat } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { PlansService } from '../plans/plans.service';
import { CreateScheduleDto, ScheduleView, UpdateScheduleDto } from './dto/schedule.dto';
import { InvalidScheduleExpressionError, ScheduleExpression, nextRun, nextRuns, parseScheduleExpression } from './schedule-expression';
import { Schedule } from './schedule.entity';

/** PostgreSQL's unique_violation: another of the function's schedules has the name. */
const UNIQUE_VIOLATION = '23505';

/** How many next runs a preview shows. */
export const PREVIEW_RUNS = 5;

/** A schedule sends AWS Lambda's Scheduled Event, which a function that takes FF's original wrapped event can't read. */
export const WRAPPED_SCHEDULE_REFUSAL =
  "A schedule sends EventBridge's Scheduled Event, as AWS Lambda passes it, and this function takes FF's original wrapped event: switch its " +
  'eventFormat to lambda (PUT /functions/{id} with {"eventFormat": "lambda"}), and read the event as AWS Lambda passes it, then schedule it';

/** The expression, parsed, or the request's 400 with what is wrong in it. */
export function expressionOf(text: string): ScheduleExpression {
  try {
    return parseScheduleExpression(text);
  } catch (error) {
    if (error instanceof InvalidScheduleExpressionError) throw new BadRequestException(error.message);
    throw error;
  }
}

/**
 * Functions' schedules, as SAM's Schedule events: each a name within its
 * function, an expression in UTC, an input or EventBridge's Scheduled Event,
 * enabled or not. Its next run is computed here, at every change, and by the
 * scheduler after each run. The account's plan limits how many it has; each
 * change goes to its audit log.
 */
@Injectable()
export class SchedulesService {
  constructor(
    @InjectRepository(Schedule) private readonly schedules: Repository<Schedule>,
    private readonly functions: FunctionsService,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
  ) {}

  view(schedule: Schedule): ScheduleView {
    const { id, functionId, name, description, expression, input, enabled, nextRunAt, lastRunAt, lastRequestId, lastOutcome, createdAt, updatedAt } = schedule;
    return {
      id,
      functionId,
      name,
      description: description ?? null,
      expression,
      input: input ?? null,
      enabled,
      nextRunAt: nextRunAt ?? null,
      lastRunAt: lastRunAt ?? null,
      lastRequestId: lastRequestId ?? null,
      lastOutcome: lastOutcome ?? null,
      createdAt,
      updatedAt,
    };
  }

  async list(accountId: string, functionId: string): Promise<ScheduleView[]> {
    await this.functions.findOne(accountId, functionId);
    return (await this.schedules.find({ where: { accountId, functionId }, order: { name: 'ASC' } })).map((schedule) => this.view(schedule));
  }

  async get(accountId: string, functionId: string, id: string): Promise<ScheduleView> {
    return this.view(await this.scheduleOf(accountId, functionId, id));
  }

  async create(accountId: string, functionId: string, dto: CreateScheduleDto, now = new Date()): Promise<ScheduleView> {
    const function_ = await this.functions.findOne(accountId, functionId);
    if (function_.eventFormat === EventFormat.WRAPPED) throw new BadRequestException(WRAPPED_SCHEDULE_REFUSAL);
    const expression = expressionOf(dto.expression);
    const plan = await this.plans.forAccount(accountId);
    const count = await this.schedules.countBy({ accountId });
    if (count >= plan.limits.schedules) {
      throw new BadRequestException(`The ${plan.name} plan allows ${plan.limits.schedules} schedules, and the account has ${count}: delete one first`);
    }
    const enabled = dto.enabled ?? true;
    const schedule = this.schedules.create({
      accountId,
      functionId,
      name: dto.name,
      description: dto.description ?? null,
      expression: dto.expression.trim(),
      input: dto.input ?? null,
      enabled,
      anchorAt: enabled ? now : null,
      nextRunAt: enabled ? nextRun(expression, now, now) : null,
      lastRunAt: null,
      lastRequestId: null,
      lastOutcome: null,
    });
    const saved = await this.saveNamed(schedule);
    await this.audit.record({
      accountId,
      action: 'schedule.create',
      resource: `function:${functionId}`,
      details: { name: saved.name, expression: saved.expression, enabled: saved.enabled },
    });
    return this.view(saved);
  }

  /**
   * Changes what is given; what is left out stays. A new expression, or being
   * enabled again, starts its runs anew from now; disabled, it has none.
   */
  async update(accountId: string, functionId: string, id: string, dto: UpdateScheduleDto, now = new Date()): Promise<ScheduleView> {
    const schedule = await this.scheduleOf(accountId, functionId, id);
    const changed = (Object.keys(dto) as Array<keyof UpdateScheduleDto>).filter((field) => dto[field] !== undefined && JSON.stringify(dto[field]) !== JSON.stringify(schedule[field]));
    if (changed.length === 0) return this.view(schedule);
    const expressionText = dto.expression?.trim() ?? schedule.expression;
    const expression = expressionOf(expressionText);
    const enabled = dto.enabled ?? schedule.enabled;
    const restart = enabled && (!schedule.enabled || expressionText !== schedule.expression);
    Object.assign(schedule, {
      name: dto.name ?? schedule.name,
      description: dto.description === undefined ? schedule.description : dto.description,
      expression: expressionText,
      input: dto.input === undefined ? schedule.input : dto.input,
      enabled,
      anchorAt: !enabled ? null : restart ? now : schedule.anchorAt,
      nextRunAt: !enabled ? null : restart ? nextRun(expression, now, now) : schedule.nextRunAt,
    });
    const saved = await this.saveNamed(schedule);
    await this.audit.record({
      accountId,
      action: 'schedule.update',
      resource: `function:${functionId}`,
      details: { name: saved.name, changed, expression: saved.expression, enabled: saved.enabled },
    });
    return this.view(saved);
  }

  async remove(accountId: string, functionId: string, id: string): Promise<void> {
    const schedule = await this.scheduleOf(accountId, functionId, id);
    await this.schedules.delete({ id: schedule.id });
    await this.audit.record({ accountId, action: 'schedule.delete', resource: `function:${functionId}`, details: { name: schedule.name } });
  }

  /** An expression's next runs, for a form's preview; 400 with what is wrong in it. */
  previewRuns(text: string, now = new Date()): Date[] {
    return nextRuns(expressionOf(text), now, PREVIEW_RUNS);
  }

  private async scheduleOf(accountId: string, functionId: string, id: string): Promise<Schedule> {
    await this.functions.findOne(accountId, functionId);
    const schedule = await this.schedules.findOne({ where: { id, accountId, functionId } });
    if (!schedule) throw new NotFoundException(`The function has no schedule ${id}`);
    return schedule;
  }

  /** Saves the schedule, 409 when another of its function's schedules has the name. */
  private async saveNamed(schedule: Schedule): Promise<Schedule> {
    try {
      return await this.schedules.save(schedule);
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) {
        throw new ConflictException(`The function has a schedule named "${schedule.name}" already: names are unique within a function`);
      }
      throw error;
    }
  }
}

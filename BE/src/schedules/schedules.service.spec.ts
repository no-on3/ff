/**
 * L1: functions' schedules, as their accounts make, change and delete them:
 * each next run computed at every change, the expression checked as
 * EventBridge would, the plan's limit, a name once per function, the audit log.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { EventFormat } from '../functions/entities/function.entity';
import { plan } from '../plans/test-fixtures';
import { Schedule } from './schedule.entity';
import { SchedulesService, WRAPPED_SCHEDULE_REFUSAL } from './schedules.service';

const ACCOUNT = '123456789012';
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const NOW = new Date('2026-10-21T08:00:30Z');

describe('SchedulesService (L1)', () => {
  let service: SchedulesService;
  let rows: Schedule[];
  let eventFormat: EventFormat;
  let limit: number;
  const audit = { record: jest.fn() };
  const functions = {
    findOne: jest.fn(async (accountId: string, id: string) => {
      if (accountId !== ACCOUNT || id !== FN) throw new NotFoundException(`Function with ID ${id} not found`);
      return { id, accountId, eventFormat, name: 'reports' };
    }),
  };
  const repository = {
    create: (values: Partial<Schedule>) => ({ ...values }) as Schedule,
    countBy: jest.fn(async ({ accountId }: { accountId: string }) => rows.filter((row) => row.accountId === accountId).length),
    find: jest.fn(async ({ where }: { where: Partial<Schedule> }) => rows.filter((row) => row.functionId === where.functionId).map((row) => ({ ...row }))),
    findOne: jest.fn(async ({ where }: { where: Partial<Schedule> }) => {
      const row = rows.find((r) => r.id === where.id && r.accountId === where.accountId && r.functionId === where.functionId);
      return row ? { ...row } : null;
    }),
    save: jest.fn(async (schedule: Schedule) => {
      if (rows.some((row) => row.id !== schedule.id && row.functionId === schedule.functionId && row.name === schedule.name)) {
        throw new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
      }
      const saved = { ...schedule, id: schedule.id ?? `s-${rows.length + 1}`, createdAt: schedule.createdAt ?? NOW, updatedAt: NOW };
      rows = [...rows.filter((row) => row.id !== saved.id), saved];
      return saved;
    }),
    delete: jest.fn(async ({ id }: { id: string }) => {
      rows = rows.filter((row) => row.id !== id);
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    eventFormat = EventFormat.LAMBDA;
    limit = 20;
    service = new SchedulesService(repository as never, functions as never, { forAccount: async () => plan({ schedules: limit }) } as never, audit as never);
  });

  it('makes a schedule, its first run one interval after it starts, and records it', async () => {
    const made = await service.create(ACCOUNT, FN, { name: 'every-5', expression: ' rate(5 minutes) ' }, NOW);

    expect(made).toMatchObject({ name: 'every-5', expression: 'rate(5 minutes)', input: null, enabled: true, nextRunAt: new Date('2026-10-21T08:05:30Z'), lastRunAt: null });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      action: 'schedule.create',
      resource: `function:${FN}`,
      details: { name: 'every-5', expression: 'rate(5 minutes)', enabled: true },
    });
  });

  it("runs a cron at the next minute it names, and keeps the schedule's input", async () => {
    const made = await service.create(ACCOUNT, FN, { name: 'nightly', expression: 'cron(0 2 * * ? *)', input: { report: 'daily' } }, NOW);

    expect([made.nextRunAt, made.input]).toEqual([new Date('2026-10-22T02:00:00Z'), { report: 'daily' }]);
  });

  it('makes a disabled schedule without a next run, and gives it one once enabled, from then', async () => {
    const made = await service.create(ACCOUNT, FN, { name: 'later', expression: 'rate(1 hour)', enabled: false }, NOW);
    expect(made.nextRunAt).toBeNull();

    const enabled = await service.update(ACCOUNT, FN, made.id, { enabled: true }, new Date('2026-10-21T10:00:00Z'));
    expect(enabled.nextRunAt).toEqual(new Date('2026-10-21T11:00:00Z'));
    const disabled = await service.update(ACCOUNT, FN, made.id, { enabled: false }, new Date('2026-10-21T10:30:00Z'));
    expect(disabled.nextRunAt).toBeNull();
  });

  it('starts the runs anew for a new expression, and keeps them for a new name or input', async () => {
    const made = await service.create(ACCOUNT, FN, { name: 'often', expression: 'rate(10 minutes)' }, NOW);

    const renamed = await service.update(ACCOUNT, FN, made.id, { name: 'often-too', input: [1] }, new Date('2026-10-21T08:04:00Z'));
    expect(renamed.nextRunAt).toEqual(made.nextRunAt);
    const changed = await service.update(ACCOUNT, FN, made.id, { expression: 'cron(30 9 * * ? *)' }, new Date('2026-10-21T08:04:00Z'));
    expect(changed.nextRunAt).toEqual(new Date('2026-10-21T09:30:00Z'));
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'schedule.update', details: expect.objectContaining({ changed: ['expression'] }) }));
  });

  it('records nothing when nothing changes', async () => {
    const made = await service.create(ACCOUNT, FN, { name: 'same', expression: 'rate(1 day)' }, NOW);
    audit.record.mockClear();

    await service.update(ACCOUNT, FN, made.id, { name: 'same', expression: 'rate(1 day)' });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['an expression EventBridge refuses', { name: 'x', expression: 'rate(5 minute)' }, 'rate(5 minute) must be rate(5 minutes): the unit is plural above 1'],
    ['a cron with both days', { name: 'x', expression: 'cron(0 8 1 * MON *)' }, 'cron(): one of the day-of-month and day-of-week fields must be "?", and only one: the other says which days'],
  ])('refuses %s, saying why', async (_case, dto, message) => {
    await expect(service.create(ACCOUNT, FN, dto, NOW)).rejects.toThrow(new BadRequestException(message));
    expect(rows).toEqual([]);
  });

  it("refuses a schedule to a function with FF's original event, saying how to switch", async () => {
    eventFormat = EventFormat.WRAPPED;

    await expect(service.create(ACCOUNT, FN, { name: 'x', expression: 'rate(1 hour)' }, NOW)).rejects.toThrow(new BadRequestException(WRAPPED_SCHEDULE_REFUSAL));
  });

  it("refuses one over the plan's limit, and a name the function's schedules have", async () => {
    limit = 1;
    await service.create(ACCOUNT, FN, { name: 'one', expression: 'rate(1 hour)' }, NOW);
    await expect(service.create(ACCOUNT, FN, { name: 'two', expression: 'rate(1 hour)' }, NOW)).rejects.toThrow(
      'The Beta plan allows 1 schedules, and the account has 1: delete one first',
    );

    limit = 5;
    await expect(service.create(ACCOUNT, FN, { name: 'one', expression: 'rate(2 hours)' }, NOW)).rejects.toThrow(
      new ConflictException('The function has a schedule named "one" already: names are unique within a function'),
    );
  });

  it("lists, reads and deletes the function's schedules, and finds no other account's", async () => {
    const made = await service.create(ACCOUNT, FN, { name: 'b', expression: 'rate(1 hour)' }, NOW);
    await service.create(ACCOUNT, FN, { name: 'a', expression: 'rate(1 day)' }, NOW);

    expect((await service.list(ACCOUNT, FN)).map((s) => s.name)).toEqual(['b', 'a']);
    expect((await service.get(ACCOUNT, FN, made.id)).name).toBe('b');
    await service.remove(ACCOUNT, FN, made.id);
    await expect(service.get(ACCOUNT, FN, made.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'schedule.delete', details: { name: 'b' } }));
    await expect(service.list('999999999999', FN)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("previews an expression's next five runs, and says what is wrong in one", () => {
    expect(service.previewRuns('cron(0 8 ? * MON *)', NOW)).toEqual([
      new Date('2026-10-26T08:00:00Z'),
      new Date('2026-11-02T08:00:00Z'),
      new Date('2026-11-09T08:00:00Z'),
      new Date('2026-11-16T08:00:00Z'),
      new Date('2026-11-23T08:00:00Z'),
    ]);
    expect(() => service.previewRuns('every hour')).toThrow(BadRequestException);
  });
});

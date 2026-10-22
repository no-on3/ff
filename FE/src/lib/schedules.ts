/**
 * A function's schedules, as the console shows and edits them: the API's
 * fields, the form's own checks before sending (the API checks the expression
 * fully, and the preview shows its runs as it is typed), and how a schedule
 * reads. contract.test.ts ties the fields and the name's rule to the API's.
 */

/** The fields of a schedule as the API answers them. */
export const SCHEDULE_FIELDS = [
  'id',
  'functionId',
  'name',
  'description',
  'expression',
  'input',
  'enabled',
  'nextRunAt',
  'lastRunAt',
  'lastRequestId',
  'lastOutcome',
  'createdAt',
  'updatedAt',
] as const;

export interface Schedule {
  id: string;
  functionId: string;
  name: string;
  description: string | null;
  expression: string;
  /** null: EventBridge's Scheduled Event. */
  input: unknown;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRequestId: string | null;
  /** success, error, timeout, throttled, running, or skipped: and why. */
  lastOutcome: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An EventBridge rule's name: letters, digits, ".", "-" and "_", 64 at most: the API's rule. */
export const SCHEDULE_NAME = /^[.\-_A-Za-z0-9]+$/;

/** Expressions to start from, as EventBridge's documentation shows them. */
export const EXPRESSION_EXAMPLES = ['rate(5 minutes)', 'rate(1 hour)', 'cron(0 8 * * ? *)', 'cron(0 18 ? * MON-FRI *)'] as const;

/** The form, as typed. */
export interface ScheduleForm {
  name: string;
  expression: string;
  description: string;
  /** JSON text; empty for EventBridge's Scheduled Event. */
  input: string;
  enabled: boolean;
}

export const emptyForm = (): ScheduleForm => ({ name: '', expression: 'rate(1 hour)', description: '', input: '', enabled: true });

/** The form filled from a schedule, to change it. */
export const formOf = (schedule: Schedule): ScheduleForm => ({
  name: schedule.name,
  expression: schedule.expression,
  description: schedule.description ?? '',
  input: schedule.input === null || schedule.input === undefined ? '' : JSON.stringify(schedule.input, null, 2),
  enabled: schedule.enabled,
});

/** What the form says, as the API takes it, or what is plainly wrong in it before sending. */
export function scheduleOf(form: ScheduleForm): { body: Record<string, unknown> } | { problem: string } {
  const name = form.name.trim();
  if (name === '' || name.length > 64 || !SCHEDULE_NAME.test(name)) {
    return { problem: "The name has 1 to 64 letters, digits, '.', '-' and '_', as an EventBridge rule's" };
  }
  if (form.expression.trim() === '') return { problem: 'Type an expression, such as rate(1 hour) or cron(0 8 * * ? *)' };
  let input: unknown = null;
  if (form.input.trim() !== '') {
    try {
      input = JSON.parse(form.input);
    } catch {
      return { problem: 'The input must be JSON, such as {"report": "daily"}; empty sends the Scheduled Event' };
    }
  }
  return {
    body: { name, expression: form.expression.trim(), description: form.description.trim() || null, input, enabled: form.enabled },
  };
}

/** How the last run went, in words: never run, under way, or its outcome and when it was due. */
export function lastRunText(schedule: Pick<Schedule, 'lastRunAt' | 'lastOutcome'>, when: (iso: string) => string): string {
  if (!schedule.lastRunAt) return 'Never run yet';
  const outcome = schedule.lastOutcome === 'running' ? 'running now' : (schedule.lastOutcome ?? 'unknown');
  return `${outcome}, due ${when(schedule.lastRunAt)}`;
}

/** When the next run is, in words: off, none left, or its time. */
export function nextRunText(schedule: Pick<Schedule, 'enabled' | 'nextRunAt'>, when: (iso: string) => string): string {
  if (!schedule.enabled) return 'Disabled';
  return schedule.nextRunAt ? when(schedule.nextRunAt) : 'No run left';
}

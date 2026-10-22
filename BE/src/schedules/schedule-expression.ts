/**
 * EventBridge's schedule expressions, as its rules take them and SAM's
 * Schedule events declare them: rate(value unit) and cron(minutes hours
 * day-of-month month day-of-week year), in UTC, a minute the finest. And the
 * next runs of one.
 */

/** An expression EventBridge wouldn't take: the message says what is wrong in it. */
export class InvalidScheduleExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleExpressionError';
  }
}

const MINUTE_MS = 60_000;
const RATE_UNITS = { minute: MINUTE_MS, hour: 60 * MINUTE_MS, day: 24 * 60 * MINUTE_MS } as const;
type RateUnit = keyof typeof RATE_UNITS;

/** The years EventBridge's cron takes. */
export const FIRST_YEAR = 1970;
export const LAST_YEAR = 2199;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** EventBridge's day-of-week: 1 is Sunday, 7 Saturday. */
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** The day of the month's rules: the days themselves, the last, the last weekday, the weekday nearest a day. */
interface DayOfMonthRule {
  days: Set<number>;
  last: boolean;
  lastWeekday: boolean;
  nearestWeekday: number[];
}

/** The day of the week's rules: the days themselves (1 Sunday to 7 Saturday), a day's last in the month, a day's nth. */
interface DayOfWeekRule {
  days: Set<number>;
  lastOf: number[];
  nth: Array<{ day: number; n: number }>;
}

export type ScheduleExpression =
  | { kind: 'rate'; value: number; unit: RateUnit; intervalMs: number }
  | {
      kind: 'cron';
      minutes: number[];
      hours: number[];
      /** null when the day of the week decides ("?" here). */
      dayOfMonth: DayOfMonthRule | null;
      months: Set<number>;
      /** null when the day of the month decides ("?" here). */
      dayOfWeek: DayOfWeekRule | null;
      years: Set<number>;
    };

const fail = (message: string): never => {
  throw new InvalidScheduleExpressionError(message);
};

function parseRate(body: string): ScheduleExpression {
  const match = /^\s*(\d+)\s+([a-z]+)\s*$/.exec(body);
  if (!match) fail('rate() takes a whole number and a unit, such as rate(5 minutes)');
  const [, digits, word] = match as RegExpExecArray;
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < 1) fail('rate() takes a value of 1 or more');
  const unit = word.replace(/s$/, '') as RateUnit;
  if (!(unit in RATE_UNITS)) fail(`rate() takes minute(s), hour(s) or day(s), not "${word}"`);
  // EventBridge's own rule: the unit is singular for 1, plural above.
  if (value === 1 && word !== unit) fail(`rate(1 ${word}) must be rate(1 ${unit}): the unit is singular for 1`);
  if (value > 1 && word === unit) fail(`rate(${value} ${word}) must be rate(${value} ${unit}s): the unit is plural above 1`);
  return { kind: 'rate', value, unit, intervalMs: value * RATE_UNITS[unit] };
}

/** A field's value: a number in its range, or a name where the field takes names. */
function valueOf(text: string, field: string, min: number, max: number, names?: string[]): number {
  const upper = text.toUpperCase();
  const named = names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + 1;
  if (!/^\d+$/.test(text)) fail(`cron(): "${text}" is not a value of the ${field} field`);
  const value = Number(text);
  if (value < min || value > max) fail(`cron(): the ${field} field takes ${min} to ${max}; got ${value}`);
  return value;
}

/**
 * A field's set of values: a list of items, each "*", a value, a range "a-b"
 * (wrapping around its end, as "FRI-MON" or "20-2"), and each with a step "/n".
 */
function values(text: string, field: string, min: number, max: number, names?: string[]): Set<number> {
  const result = new Set<number>();
  for (const item of text.split(',')) {
    const [range, stepText, ...extra] = item.split('/');
    if (extra.length > 0 || range === '' || stepText === '') fail(`cron(): "${item}" is not an item of the ${field} field`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || step < 1)) fail(`cron(): the step in "${item}" must be a whole number of 1 or more`);
    let from: number;
    let to: number;
    if (range === '*') [from, to] = [min, max];
    else if (range.includes('-')) {
      const [a, b, ...more] = range.split('-');
      if (more.length > 0) fail(`cron(): "${item}" is not a range of the ${field} field`);
      [from, to] = [valueOf(a, field, min, max, names), valueOf(b, field, min, max, names)];
    } else {
      from = valueOf(range, field, min, max, names);
      // "5/15": from 5, every 15, to the field's end.
      to = stepText === undefined ? from : max;
    }
    const span = to >= from ? to - from : max - from + 1 + to - min;
    for (let offset = 0; offset <= span; offset += step) result.add(((from - min + offset) % (max - min + 1)) + min);
  }
  return result;
}

function dayOfMonthRule(text: string): DayOfMonthRule {
  const rule: DayOfMonthRule = { days: new Set(), last: false, lastWeekday: false, nearestWeekday: [] };
  const plain: string[] = [];
  for (const item of text.split(',')) {
    const upper = item.toUpperCase();
    if (upper === 'L') rule.last = true;
    else if (upper === 'LW') rule.lastWeekday = true;
    else if (/^\d+W$/.test(upper)) rule.nearestWeekday.push(valueOf(upper.slice(0, -1), 'day-of-month', 1, 31));
    else if (/[LW]/.test(upper)) fail(`cron(): "${item}" is not an item of the day-of-month field: L, LW and nW are`);
    else plain.push(item);
  }
  if (plain.length > 0) rule.days = values(plain.join(','), 'day-of-month', 1, 31);
  return rule;
}

function dayOfWeekRule(text: string): DayOfWeekRule {
  const rule: DayOfWeekRule = { days: new Set(), lastOf: [], nth: [] };
  const plain: string[] = [];
  for (const item of text.split(',')) {
    const upper = item.toUpperCase();
    if (upper === 'L') rule.days.add(7); // "L" alone: the week's last day, Saturday
    else if (/^[A-Z0-9]+L$/.test(upper)) rule.lastOf.push(valueOf(upper.slice(0, -1), 'day-of-week', 1, 7, DAYS));
    else if (upper.includes('#')) {
      const [day, n, ...more] = upper.split('#');
      if (more.length > 0 || !/^[1-5]$/.test(n ?? '')) fail(`cron(): "${item}" must be a day and its week in the month, 1 to 5, such as 2#1, the first Monday`);
      rule.nth.push({ day: valueOf(day, 'day-of-week', 1, 7, DAYS), n: Number(n) });
    } else plain.push(item);
  }
  if (plain.length > 0) for (const day of values(plain.join(','), 'day-of-week', 1, 7, DAYS)) rule.days.add(day);
  return rule;
}

function parseCron(body: string): ScheduleExpression {
  const fields = body.trim().split(/\s+/);
  if (fields.length !== 6) fail(`cron() takes six fields, minutes hours day-of-month month day-of-week year; got ${fields.length}`);
  const [minutes, hours, dayOfMonth, month, dayOfWeek, year] = fields;
  for (const [name, text] of [['minutes', minutes], ['hours', hours], ['month', month], ['year', year]] as const) {
    if (text.includes('?')) fail(`cron(): the ${name} field can't be "?": only the day-of-month or the day-of-week can`);
  }
  // EventBridge's rule: one of the two days is "?", the other decides.
  if ((dayOfMonth === '?') === (dayOfWeek === '?')) {
    fail('cron(): one of the day-of-month and day-of-week fields must be "?", and only one: the other says which days');
  }
  return {
    kind: 'cron',
    minutes: [...values(minutes, 'minutes', 0, 59)].sort((a, b) => a - b),
    hours: [...values(hours, 'hours', 0, 23)].sort((a, b) => a - b),
    dayOfMonth: dayOfMonth === '?' ? null : dayOfMonthRule(dayOfMonth),
    months: values(month, 'month', 1, 12, MONTHS),
    dayOfWeek: dayOfWeek === '?' ? null : dayOfWeekRule(dayOfWeek),
    years: values(year, 'year', FIRST_YEAR, LAST_YEAR),
  };
}

/** Parses an expression as EventBridge takes it; throws InvalidScheduleExpressionError with what is wrong. */
export function parseScheduleExpression(text: string): ScheduleExpression {
  const match = /^(rate|cron)\((.*)\)$/s.exec(text.trim());
  if (!match) fail('A schedule is rate(value unit), such as rate(5 minutes), or cron(minutes hours day-of-month month day-of-week year), such as cron(0 8 * * ? *)');
  const [, kind, body] = match as RegExpExecArray;
  return kind === 'rate' ? parseRate(body) : parseCron(body);
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekdayOf = (year: number, month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1; // 1 Sunday

/** The weekday nearest a day of the month, within the month: "15W". */
function nearestWeekday(year: number, month: number, day: number): number | null {
  const last = daysInMonth(year, month);
  if (day > last) return null;
  const weekday = weekdayOf(year, month, day);
  if (weekday === 7) return day === 1 ? 3 : day - 1; // Saturday: the Friday before, or Monday the 3rd
  if (weekday === 1) return day === last ? day - 2 : day + 1; // Sunday: the Monday after, or the Friday before at the month's end
  return day;
}

function lastWeekday(year: number, month: number): number {
  const last = daysInMonth(year, month);
  const weekday = weekdayOf(year, month, last);
  return weekday === 7 ? last - 1 : weekday === 1 ? last - 2 : last;
}

function dayMatches(expression: Extract<ScheduleExpression, { kind: 'cron' }>, year: number, month: number, day: number): boolean {
  if (expression.dayOfMonth) {
    const rule = expression.dayOfMonth;
    return (
      rule.days.has(day) ||
      (rule.last && day === daysInMonth(year, month)) ||
      (rule.lastWeekday && day === lastWeekday(year, month)) ||
      rule.nearestWeekday.some((n) => nearestWeekday(year, month, n) === day)
    );
  }
  const rule = expression.dayOfWeek as DayOfWeekRule;
  const weekday = weekdayOf(year, month, day);
  return (
    rule.days.has(weekday) ||
    (rule.lastOf.includes(weekday) && day + 7 > daysInMonth(year, month)) ||
    rule.nth.some(({ day: d, n }) => d === weekday && Math.ceil(day / 7) === n)
  );
}

/** The first run of a cron expression strictly after the time; null when there is none left, past its years. */
function nextCronRun(expression: Extract<ScheduleExpression, { kind: 'cron' }>, after: Date): Date | null {
  const start = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  let day = start.getUTCDate();
  let fromMinute = start.getUTCHours() * 60 + start.getUTCMinutes();
  while (year <= LAST_YEAR) {
    if (!expression.years.has(year)) {
      [year, month, day, fromMinute] = [year + 1, 1, 1, 0];
      continue;
    }
    if (!expression.months.has(month)) {
      [month, day, fromMinute] = [month + 1, 1, 0];
      if (month > 12) [year, month] = [year + 1, 1];
      continue;
    }
    if (dayMatches(expression, year, month, day)) {
      for (const hour of expression.hours) {
        for (const minute of expression.minutes) {
          if (hour * 60 + minute >= fromMinute) return new Date(Date.UTC(year, month - 1, day, hour, minute));
        }
      }
    }
    [day, fromMinute] = [day + 1, 0];
    if (day > daysInMonth(year, month)) {
      [month, day] = [month + 1, 1];
      if (month > 12) [year, month] = [year + 1, 1];
    }
  }
  return null;
}

/**
 * The next run strictly after `after`. A rate's runs are every interval from
 * `anchor`, its first run's time, so a late run doesn't move them: the next is
 * the first of them after `after`. A cron's, the first minute it names after.
 * Null when a cron has no run left.
 */
export function nextRun(expression: ScheduleExpression, after: Date, anchor?: Date): Date | null {
  if (expression.kind === 'cron') return nextCronRun(expression, after);
  const base = (anchor ?? after).getTime();
  const steps = Math.max(1, Math.floor((after.getTime() - base) / expression.intervalMs) + 1);
  return new Date(base + steps * expression.intervalMs);
}

/** The next runs, for a preview: `count` of them at most. */
export function nextRuns(expression: ScheduleExpression, after: Date, count: number): Date[] {
  const runs: Date[] = [];
  let from = after;
  const anchor = expression.kind === 'rate' ? after : undefined;
  while (runs.length < count) {
    const run = nextRun(expression, from, anchor);
    if (!run) break;
    runs.push(run);
    from = run;
  }
  return runs;
}

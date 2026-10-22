import { InvalidScheduleExpressionError, nextRun, nextRuns, parseScheduleExpression } from './schedule-expression';

const at = (iso: string) => new Date(iso);
/** The next runs of an expression after a time, as ISO strings without the milliseconds. */
const runs = (expression: string, after: string, count = 3) =>
  nextRuns(parseScheduleExpression(expression), at(after), count).map((run) => run.toISOString().replace('.000Z', 'Z'));

describe("EventBridge's schedule expressions", () => {
  describe('rate()', () => {
    it.each([
      ['rate(1 minute)', 60_000],
      ['rate(5 minutes)', 300_000],
      ['rate(1 hour)', 3_600_000],
      ['rate(12 hours)', 43_200_000],
      ['rate(1 day)', 86_400_000],
      ['rate(7 days)', 604_800_000],
    ])('takes %s, its example in the documentation', (expression, intervalMs) => {
      expect(parseScheduleExpression(expression)).toEqual(expect.objectContaining({ kind: 'rate', intervalMs }));
    });

    it.each([
      ['rate(1 minutes)', 'rate(1 minutes) must be rate(1 minute): the unit is singular for 1'],
      ['rate(5 minute)', 'rate(5 minute) must be rate(5 minutes): the unit is plural above 1'],
      ['rate(0 minutes)', 'rate() takes a value of 1 or more'],
      ['rate(5 seconds)', 'rate() takes minute(s), hour(s) or day(s), not "seconds"'],
      ['rate(1.5 hours)', 'rate() takes a whole number and a unit, such as rate(5 minutes)'],
      ['rate(-1 day)', 'rate() takes a whole number and a unit, such as rate(5 minutes)'],
    ])('refuses %s, saying why', (expression, message) => {
      expect(() => parseScheduleExpression(expression)).toThrow(new InvalidScheduleExpressionError(message));
    });

    it('runs every interval from its first run, which a late run doesn\'t move', () => {
      const rate = parseScheduleExpression('rate(5 minutes)');
      const created = at('2026-10-21T08:00:30Z');

      expect(nextRun(rate, created, created)).toEqual(at('2026-10-21T08:05:30Z'));
      // Late by 12 minutes: the next is the first of its runs after now, not one per run missed.
      expect(nextRun(rate, at('2026-10-21T08:17:00Z'), created)).toEqual(at('2026-10-21T08:20:30Z'));
    });
  });

  describe('cron()', () => {
    it.each([
      ['cron(0 10 * * ? *)', '2026-10-21T10:00:00Z', ['2026-10-22T10:00:00Z', '2026-10-23T10:00:00Z']],
      ['cron(15 12 * * ? *)', '2026-10-21T10:00:00Z', ['2026-10-21T12:15:00Z', '2026-10-22T12:15:00Z']],
      // 2026-10-23 is a Friday: then Monday.
      ['cron(0 18 ? * MON-FRI *)', '2026-10-23T17:00:00Z', ['2026-10-23T18:00:00Z', '2026-10-26T18:00:00Z']],
      ['cron(0 8 1 * ? *)', '2026-10-21T10:00:00Z', ['2026-11-01T08:00:00Z', '2026-12-01T08:00:00Z']],
      ['cron(0/15 * * * ? *)', '2026-10-21T10:07:00Z', ['2026-10-21T10:15:00Z', '2026-10-21T10:30:00Z']],
      // Saturday the 24th: the next is Monday's first.
      ['cron(0/10 * ? * MON-FRI *)', '2026-10-23T23:55:00Z', ['2026-10-26T00:00:00Z', '2026-10-26T00:10:00Z']],
      ['cron(0/5 8-17 ? * MON-FRI *)', '2026-10-21T17:52:00Z', ['2026-10-21T17:55:00Z', '2026-10-22T08:00:00Z']],
      // The first Monday of each month.
      ['cron(0 9 ? * 2#1 *)', '2026-10-21T00:00:00Z', ['2026-11-02T09:00:00Z', '2026-12-07T09:00:00Z']],
    ])('runs %s as EventBridge\'s documentation says', (expression, after, expected) => {
      expect(runs(expression, after, 2)).toEqual(expected);
    });

    it('runs strictly after the time, to the minute, in UTC', () => {
      expect(runs('cron(30 9 * * ? *)', '2026-10-21T09:30:00Z', 1)).toEqual(['2026-10-22T09:30:00Z']);
      expect(runs('cron(30 9 * * ? *)', '2026-10-21T09:29:59.999Z', 1)).toEqual(['2026-10-21T09:30:00Z']);
    });

    it('takes the last day of the month, L, in February of a leap year and not', () => {
      expect(runs('cron(0 0 L * ? *)', '2027-01-31T12:00:00Z', 2)).toEqual(['2027-02-28T00:00:00Z', '2027-03-31T00:00:00Z']);
      expect(runs('cron(0 0 L 2 ? *)', '2027-03-01T00:00:00Z', 2)).toEqual(['2028-02-29T00:00:00Z', '2029-02-28T00:00:00Z']);
    });

    it('takes the last weekday of the month, LW, and the weekday nearest a day, W, without leaving the month', () => {
      // 2026-10-31 is a Saturday: the last weekday is Friday the 30th; 2027-01-31 a Sunday: Friday the 29th.
      expect(runs('cron(0 12 LW * ? *)', '2026-10-01T00:00:00Z', 4)).toEqual([
        '2026-10-30T12:00:00Z',
        '2026-11-30T12:00:00Z',
        '2026-12-31T12:00:00Z',
        '2027-01-29T12:00:00Z',
      ]);
      // 2026-08-01 is a Saturday: 1W is Monday the 3rd, never July's 31st.
      expect(runs('cron(0 12 1W * ? *)', '2026-07-15T00:00:00Z', 1)).toEqual(['2026-08-03T12:00:00Z']);
      // 2026-05-31 is a Sunday, the month's last day: 31W is Friday the 29th; months without a 31st have none.
      expect(runs('cron(0 12 31W * ? *)', '2026-04-01T00:00:00Z', 2)).toEqual(['2026-05-29T12:00:00Z', '2026-07-31T12:00:00Z']);
    });

    it('takes a day of the week\'s last in the month, nL, and the nth, # — skipping the months without a fifth', () => {
      // The last Friday (6) of each month.
      expect(runs('cron(0 17 ? * 6L *)', '2026-10-01T00:00:00Z', 2)).toEqual(['2026-10-30T17:00:00Z', '2026-11-27T17:00:00Z']);
      // The fifth Thursday (5): October 2026 has one (the 29th), November none (its Thursdays end on the 26th), December the 31st.
      expect(runs('cron(0 9 ? * 5#5 *)', '2026-10-01T00:00:00Z', 2)).toEqual(['2026-10-29T09:00:00Z', '2026-12-31T09:00:00Z']);
    });

    it('takes names for months and days, in any case, and "L" alone for Saturday', () => {
      expect(runs('cron(0 6 ? jan-mar sun *)', '2026-12-20T00:00:00Z', 2)).toEqual(['2027-01-03T06:00:00Z', '2027-01-10T06:00:00Z']);
      expect(runs('cron(0 6 ? * L *)', '2026-10-21T00:00:00Z', 1)).toEqual(['2026-10-24T06:00:00Z']);
    });

    it('wraps a range around its end: 20-2 is 20:00 to 02:00, FRI-MON the weekend', () => {
      expect(runs('cron(0 20-2 * * ? *)', '2026-10-21T19:30:00Z', 8)).toEqual([
        '2026-10-21T20:00:00Z',
        '2026-10-21T21:00:00Z',
        '2026-10-21T22:00:00Z',
        '2026-10-21T23:00:00Z',
        '2026-10-22T00:00:00Z',
        '2026-10-22T01:00:00Z',
        '2026-10-22T02:00:00Z',
        '2026-10-22T20:00:00Z',
      ]);
      expect(runs('cron(0 12 ? * FRI-MON *)', '2026-10-21T00:00:00Z', 4)).toEqual([
        '2026-10-23T12:00:00Z',
        '2026-10-24T12:00:00Z',
        '2026-10-25T12:00:00Z',
        '2026-10-26T12:00:00Z',
      ]);
    });

    it('takes steps from a value, from a range, and from *, and lists', () => {
      expect(runs('cron(5/20 * * * ? *)', '2026-10-21T10:00:00Z', 4)).toEqual([
        '2026-10-21T10:05:00Z',
        '2026-10-21T10:25:00Z',
        '2026-10-21T10:45:00Z',
        '2026-10-21T11:05:00Z',
      ]);
      expect(runs('cron(0 8-16/4 * * ? *)', '2026-10-21T00:00:00Z', 4)).toEqual([
        '2026-10-21T08:00:00Z',
        '2026-10-21T12:00:00Z',
        '2026-10-21T16:00:00Z',
        '2026-10-22T08:00:00Z',
      ]);
      expect(runs('cron(0 */12 1,15 * ? *)', '2026-10-01T00:00:00Z', 3)).toEqual(['2026-10-01T12:00:00Z', '2026-10-15T00:00:00Z', '2026-10-15T12:00:00Z']);
    });

    it('runs within its years, and no more after them', () => {
      expect(runs('cron(0 0 1 1 ? 2027-2028)', '2026-10-21T00:00:00Z', 3)).toEqual(['2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z']);
      expect(nextRun(parseScheduleExpression('cron(0 0 1 1 ? 2025)'), at('2026-10-21T00:00:00Z'))).toBeNull();
      expect(runs('cron(59 23 31 12 ? 2199)', '2199-12-30T00:00:00Z', 2)).toEqual(['2199-12-31T23:59:00Z']);
    });

    it.each([
      ['five fields', 'cron(0 10 * * ?)', 'cron() takes six fields, minutes hours day-of-month month day-of-week year; got 5'],
      ['both days', 'cron(0 10 1 * MON *)', 'cron(): one of the day-of-month and day-of-week fields must be "?", and only one: the other says which days'],
      ['neither day', 'cron(0 10 ? * ? *)', 'cron(): one of the day-of-month and day-of-week fields must be "?", and only one: the other says which days'],
      ['"?" for the hours', 'cron(0 ? * * ? *)', 'cron(): the hours field can\'t be "?": only the day-of-month or the day-of-week can'],
      ['minute 60', 'cron(60 10 * * ? *)', 'cron(): the minutes field takes 0 to 59; got 60'],
      ['hour 24', 'cron(0 24 * * ? *)', 'cron(): the hours field takes 0 to 23; got 24'],
      ['day 32', 'cron(0 10 32 * ? *)', 'cron(): the day-of-month field takes 1 to 31; got 32'],
      ['month 13', 'cron(0 10 1 13 ? *)', 'cron(): the month field takes 1 to 12; got 13'],
      ['a day of the week 8', 'cron(0 10 ? * 8 *)', 'cron(): the day-of-week field takes 1 to 7; got 8'],
      ['a year before 1970', 'cron(0 10 * * ? 1969)', 'cron(): the year field takes 1970 to 2199; got 1969'],
      ['a name that is none', 'cron(0 10 ? * FUN *)', 'cron(): "FUN" is not a value of the day-of-week field'],
      ['a sixth week', 'cron(0 10 ? * 2#6 *)', 'cron(): "2#6" must be a day and its week in the month, 1 to 5, such as 2#1, the first Monday'],
      ['W where it means nothing', 'cron(0 10 W * ? *)', 'cron(): "W" is not an item of the day-of-month field: L, LW and nW are'],
      ['a step of 0', 'cron(0/0 * * * ? *)', 'cron(): the step in "0/0" must be a whole number of 1 or more'],
      ['seconds, more often than once a minute', 'cron(0 0/1 * * * ? *)', 'cron() takes six fields, minutes hours day-of-month month day-of-week year; got 7'],
      ['neither rate nor cron', 'at(2026-10-21T10:00:00)', 'A schedule is rate(value unit), such as rate(5 minutes), or cron(minutes hours day-of-month month day-of-week year), such as cron(0 8 * * ? *)'],
    ])('refuses %s, saying why', (_case, expression, message) => {
      expect(() => parseScheduleExpression(expression)).toThrow(new InvalidScheduleExpressionError(message));
    });
  });
});

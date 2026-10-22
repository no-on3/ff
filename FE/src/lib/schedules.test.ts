import { describe, expect, it } from 'vitest';
import { Schedule, emptyForm, formOf, lastRunText, nextRunText, scheduleOf } from './schedules';

const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');

describe("a schedule's form", () => {
  it("gives the API SAM's fields: the name, the expression, the input as JSON, the description, enabled", () => {
    expect(scheduleOf({ name: ' nightly ', expression: ' cron(0 2 * * ? *) ', description: ' The report ', input: '{"report": "daily"}', enabled: false })).toEqual({
      body: { name: 'nightly', expression: 'cron(0 2 * * ? *)', description: 'The report', input: { report: 'daily' }, enabled: false },
    });
  });

  it('sends no input and no description when they are left empty: the Scheduled Event', () => {
    expect(scheduleOf({ ...emptyForm(), name: 'hourly' })).toEqual({
      body: { name: 'hourly', expression: 'rate(1 hour)', description: null, input: null, enabled: true },
    });
  });

  it.each([
    ['no name', { name: '' }, "The name has 1 to 64 letters, digits, '.', '-' and '_', as an EventBridge rule's"],
    ['a name with a space', { name: 'my report' }, "The name has 1 to 64 letters, digits, '.', '-' and '_', as an EventBridge rule's"],
    ['no expression', { name: 'x', expression: ' ' }, 'Type an expression, such as rate(1 hour) or cron(0 8 * * ? *)'],
    ['an input that is no JSON', { name: 'x', input: '{report: daily}' }, 'The input must be JSON, such as {"report": "daily"}; empty sends the Scheduled Event'],
  ])('says what is wrong: %s', (_case, fields, problem) => {
    expect(scheduleOf({ ...emptyForm(), ...fields })).toEqual({ problem });
  });

  it('fills the form from a schedule, and back to the same body', () => {
    const schedule = { name: 'n', expression: 'rate(5 minutes)', description: null, input: [1, 'two'], enabled: true } as Schedule;

    expect(scheduleOf(formOf(schedule))).toEqual({ body: { name: 'n', expression: 'rate(5 minutes)', description: null, input: [1, 'two'], enabled: true } });
  });
});

describe('a schedule, to read', () => {
  it('says when it runs next, or why not', () => {
    expect(nextRunText({ enabled: true, nextRunAt: '2026-10-22T02:00:00.000Z' }, when)).toBe('2026-10-22 02:00');
    expect(nextRunText({ enabled: false, nextRunAt: null }, when)).toBe('Disabled');
    expect(nextRunText({ enabled: true, nextRunAt: null }, when)).toBe('No run left');
  });

  it('says how its last run went', () => {
    expect(lastRunText({ lastRunAt: null, lastOutcome: null }, when)).toBe('Never run yet');
    expect(lastRunText({ lastRunAt: '2026-10-21T02:00:00.000Z', lastOutcome: 'success' }, when)).toBe('success, due 2026-10-21 02:00');
    expect(lastRunText({ lastRunAt: '2026-10-21T02:00:00.000Z', lastOutcome: 'running' }, when)).toBe('running now, due 2026-10-21 02:00');
  });
});

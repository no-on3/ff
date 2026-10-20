/** L1 for the window a logs request asks the store for (P-43). */
import { BadRequestException } from '@nestjs/common';
import { logsQuery } from './logs-window';

const NOW = new Date('2026-10-17T12:00:00Z');
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('logsQuery', () => {
  it("asks for the newest 200 lines of the plan's whole retention, up to now, by default", () => {
    expect(logsQuery({}, 14, NOW)).toEqual({ start: ago(14 * DAY), end: NOW, limit: 200, q: undefined, requestId: undefined, cursor: undefined });
  });

  it('takes limit, or tail, its older name, which `ff logs` sends', () => {
    expect(logsQuery({ limit: 50 }, 14, NOW)?.limit).toBe(50);
    expect(logsQuery({ tail: 20 }, 14, NOW)?.limit).toBe(20);
  });

  it('starts the window sinceSeconds ago, or at start, and ends it at end', () => {
    expect(logsQuery({ sinceSeconds: 600 }, 14, NOW)).toMatchObject({ start: ago(600_000), end: NOW });
    expect(logsQuery({ start: '2026-10-17T10:00:00+01:00', end: '2026-10-17T11:00:00Z' }, 14, NOW)).toMatchObject({
      start: new Date('2026-10-17T09:00:00Z'),
      end: new Date('2026-10-17T11:00:00Z'),
    });
  });

  it("never starts before the plan's retention, though the store keeps the longest plan's", () => {
    expect(logsQuery({ sinceSeconds: 20 * 86_400 }, 14, NOW)?.start).toEqual(ago(14 * DAY));
    expect(logsQuery({ start: '2026-09-01T00:00:00Z' }, 14, NOW)?.start).toEqual(ago(14 * DAY));
    expect(logsQuery({ start: '2026-09-01T00:00:00Z' }, 30, NOW)?.start).toEqual(ago(30 * DAY));
  });

  it('asks for nothing when the whole window is older than the retention', () => {
    expect(logsQuery({ start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' }, 14, NOW)).toBeNull();
  });

  it('passes the phrase, the call and the cursor on', () => {
    expect(logsQuery({ q: 'time out', requestId: 'r-1', cursor: 'abc' }, 14, NOW)).toMatchObject({ q: 'time out', requestId: 'r-1', cursor: 'abc' });
  });

  it.each([
    ['limit with tail', { limit: 5, tail: 5 }, "Give limit or tail, not both: tail is limit's older name"],
    ['start with sinceSeconds', { start: '2026-10-17T10:00:00Z', sinceSeconds: 60 }, 'Give start or sinceSeconds, not both'],
    ['a start after the end', { start: '2026-10-17T11:00:00Z', end: '2026-10-17T10:00:00Z' }, 'start must be before end'],
    ['a start at the end', { start: '2026-10-17T11:00:00Z', end: '2026-10-17T11:00:00Z' }, 'start must be before end'],
    ['a day February lacks', { start: '2026-02-30T10:00:00Z' }, 'start is not a valid time'],
    ['a thirteenth month', { end: '2026-13-01T10:00:00Z' }, 'end is not a valid time'],
    ['a 25th hour', { end: '2026-10-17T25:00:00Z' }, 'end is not a valid time'],
  ])('refuses %s', (_, request, message) => {
    const call = () => logsQuery(request, 14, NOW);
    expect(call).toThrow(BadRequestException);
    expect(call).toThrow(message);
  });
});

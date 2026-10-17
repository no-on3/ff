import { BadRequestException } from '@nestjs/common';
import type { LogsQuery } from '../orchestrator/orchestrator.types';
import { DEFAULT_LOG_LINES, FunctionLogsQuery } from './dto/function-logs.dto';

const DAY_MS = 86_400_000;

/**
 * What to ask the log store for a logs request (P-43). The window runs from
 * `start`, or `sinceSeconds` ago, else from the plan's retention, to `end`,
 * else now; it never starts before the plan's retention, so an account reads
 * only what its plan keeps although the store keeps the longest plan's. Null
 * when nothing can be in it: all of it older than the retention.
 */
export function logsQuery(request: FunctionLogsQuery, retentionDays: number, now: Date): LogsQuery | null {
  if (request.limit !== undefined && request.tail !== undefined) {
    throw new BadRequestException("Give limit or tail, not both: tail is limit's older name");
  }
  if (request.start !== undefined && request.sinceSeconds !== undefined) throw new BadRequestException('Give start or sinceSeconds, not both');
  const start = request.start === undefined ? undefined : instant(request.start, 'start');
  const end = request.end === undefined ? undefined : instant(request.end, 'end');
  if (start && end && start >= end) throw new BadRequestException('start must be before end');

  const earliest = new Date(now.getTime() - retentionDays * DAY_MS);
  const from = start ?? (request.sinceSeconds === undefined ? earliest : new Date(now.getTime() - request.sinceSeconds * 1000));
  const window = { start: from < earliest ? earliest : from, end: end ?? now };
  if (window.start >= window.end) return null;
  return {
    ...window,
    limit: request.limit ?? request.tail ?? DEFAULT_LOG_LINES,
    q: request.q,
    requestId: request.requestId,
    cursor: request.cursor,
  };
}

/** A time the DTO found in RFC 3339's shape, checked as a date: neither 2026-02-30 nor month 13 is one. */
function instant(text: string, name: string): Date {
  const date = new Date(text);
  const [year, month, day] = text.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const valid = !Number.isNaN(date.getTime()) && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
  if (!valid) throw new BadRequestException(`${name} is not a valid time`);
  return date;
}

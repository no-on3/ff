import type { PillTone } from '../components/StatusPill';
import type { Trace, TraceCall } from '../services/api';

/** A call on its trace's timeline: its start after the first call's, and its bar's start and length in % of the trace's span. */
export interface TimelineRow {
  call: TraceCall;
  offsetMs: number;
  left: number;
  width: number;
}

/**
 * A trace's calls on its timeline, which runs from the first call's start to the end of the last to end: each call's
 * bar 1 % wide at least, so that a short call shows, and kept on the timeline.
 */
export function timeline(trace: Trace): { rows: TimelineRow[]; spanMs: number } {
  const starts = trace.calls.map((call) => Date.parse(call.createdAt));
  const known = starts.filter(Number.isFinite);
  const first = known.length ? Math.min(...known) : 0;
  const offsets = starts.map((start) => (Number.isFinite(start) ? start - first : 0));
  const spanMs = Math.max(1, ...trace.calls.map((call, index) => offsets[index] + call.duration));
  const rows = trace.calls.map((call, index) => {
    const left = Math.min(99, (offsets[index] / spanMs) * 100);
    const width = Math.min(100 - left, Math.max(1, (call.duration / spanMs) * 100));
    return { call, offsetMs: offsets[index], left, width };
  });
  return { rows, spanMs };
}

/** A time since the trace's start, as `ff trace` says it: `12 ms`, `1.31 s`, `2 min 5 s`, `1 h 4 min`. */
export function elapsedText(ms: number): string {
  const time = Math.max(0, ms);
  if (time < 1000) return `${Math.round(time)} ms`;
  if (time < 60_000) return `${(time / 1000).toFixed(2)} s`;
  const seconds = Math.round(time / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** The function that ran a call, with the alias it named or its version: `orders`, `orders:live`, `orders:3`. */
export function qualifiedName(call: Pick<TraceCall, 'functionName' | 'alias' | 'version'>): string {
  if (call.alias) return `${call.functionName}:${call.alias}`;
  if (call.version !== null) return `${call.functionName}:${call.version}`;
  return call.functionName;
}

/** What a trace is, in a line: its calls, its functions, and how long it lasted. */
export function traceSummary(trace: Trace, spanMs: number): string {
  const functions = new Set(trace.calls.map((call) => call.functionId)).size;
  const counted = (count: number, what: string) => `${count.toLocaleString('en-US')} ${what}${count === 1 ? '' : 's'}`;
  return `${counted(trace.calls.length, 'call')} of ${counted(functions, 'function')}, over ${elapsedText(spanMs)}`;
}

/** A bar's color, by its call's status's tone, as the history's pills have them. */
export const BAR_TONES: Record<PillTone, string> = {
  ok: 'bg-green-500',
  busy: 'bg-blue-400',
  failed: 'bg-red-500',
  warn: 'bg-amber-400',
  idle: 'bg-gray-400',
};

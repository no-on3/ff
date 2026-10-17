import type { FunctionLogLine } from '../orchestrator.types';

/** A line as the API gives it with timestamps=true: RFC 3339 in UTC with up to nine decimals, a space, then the line. */
const TIMESTAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z (.*)$/;
/** The runtimes' lines around each call, as Lambda writes them (D6): START, END and REPORT, each with the request ID. */
const MARKER = /^(START|END|REPORT) RequestId: (\S+)/;

/** The longest message kept, in characters: a longer line is cut, and says so. */
export const MAX_MESSAGE = 16_384;
export const TRUNCATED = ' …[truncated]';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A pod's log, oldest first, one entry per line, each with the call it
 * belongs to. Times get all nine decimals, which Kubernetes trims, so that
 * they sort as text. With one call per instance (D14), a call's lines are
 * those from its START to its REPORT; lines before a pod's first START are
 * the runtime's own, or a cold start's. The lines read may begin inside a
 * call, which its END names.
 */
export function podLogLines(text: string, instance: string): FunctionLogLine[] {
  const lines: FunctionLogLine[] = [];
  for (const raw of text.split('\n')) {
    const match = TIMESTAMPED.exec(raw);
    if (!match) continue; // the empty end, or a line cut by the read's byte limit
    const message = match[3].length > MAX_MESSAGE ? `${match[3].slice(0, MAX_MESSAGE)}${TRUNCATED}` : match[3];
    lines.push({ time: `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}Z`, instance, requestId: null, message });
  }
  let current: string | null = null;
  let before: number | null = 0; // the lines before the first marker, until there is one
  lines.forEach((line, index) => {
    const marker = MARKER.exec(line.message);
    if (!marker) {
      line.requestId = current;
      return;
    }
    const [, kind, requestId] = marker;
    // The read began inside a call: the lines before its END are its own.
    if (before !== null && kind !== 'START') for (let earlier = before; earlier < index; earlier++) lines[earlier].requestId = requestId;
    before = null;
    line.requestId = requestId;
    current = kind === 'REPORT' ? null : requestId; // a call runs from its START to its REPORT
  });
  return lines;
}

/**
 * Every instance's lines in one list, oldest first, the newest `tail` of
 * them: by time, then by instance; lines of the same time keep their
 * instance's order.
 */
export function mergeLogs(perInstance: FunctionLogLine[][], tail: number): FunctionLogLine[] {
  const all = perInstance.flatMap((lines) => lines.map((line, index) => ({ line, index })));
  all.sort((a, b) => compare(a.line.time, b.line.time) || compare(a.line.instance, b.line.instance) || a.index - b.index);
  return all.slice(Math.max(0, all.length - tail)).map(({ line }) => line);
}

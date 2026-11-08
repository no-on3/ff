import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidScheduleExpressionError, nextRun, nextRuns, parseScheduleExpression } from './schedule-expression';

/** EventBridge's expressions and their next runs, in the table ff's reader is tested against too. */
interface RunsCase {
  expression: string;
  after: string;
  anchor?: string;
  count?: number;
  runs: string[];
}
const table = JSON.parse(readFileSync(join(__dirname, 'schedule-expressions.json'), 'utf8')) as {
  rates: Array<{ expression: string; intervalMs: number }>;
  refused: Array<{ title: string; expression: string; message: string }>;
  runs: Array<{ title: string; cases: RunsCase[] }>;
};

const at = (iso: string) => new Date(iso);
const iso = (run: Date) => run.toISOString().replace('.000Z', 'Z');

/** A case's next runs, as ISO strings without the milliseconds: a rate's from its anchor, when the case gives one. */
function runsOf({ expression, after, anchor, count, runs }: RunsCase): string[] {
  const parsed = parseScheduleExpression(expression);
  const wanted = count ?? runs.length;
  if (!anchor) return nextRuns(parsed, at(after), wanted).map(iso);
  const found: Date[] = [];
  for (let from = at(after); found.length < wanted; ) {
    const run = nextRun(parsed, from, at(anchor));
    if (!run) break;
    found.push(run);
    from = run;
  }
  return found.map(iso);
}

describe("EventBridge's schedule expressions", () => {
  it.each(table.rates)('takes $expression, its example in the documentation', ({ expression, intervalMs }) => {
    expect(parseScheduleExpression(expression)).toEqual(expect.objectContaining({ kind: 'rate', intervalMs }));
  });

  it.each(table.runs)('$title', ({ cases }) => {
    // Each case's expression beside its runs, so that a failure names the case.
    for (const runsCase of cases) {
      expect({ expression: runsCase.expression, runs: runsOf(runsCase) }).toEqual({ expression: runsCase.expression, runs: runsCase.runs });
    }
  });

  it.each(table.refused)('refuses $title, saying why', ({ expression, message }) => {
    expect(() => parseScheduleExpression(expression)).toThrow(new InvalidScheduleExpressionError(message));
  });
});

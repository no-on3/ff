// The backend's reader, run by Node.js as it is (its types stripped), on the lines generate.mjs makes: what
// src/main.rs prints for the same lines, word for word, the times in Unix milliseconds.
import { createInterface } from 'node:readline';
import { InvalidScheduleExpressionError, nextRuns, parseScheduleExpression } from '../../../BE/src/schedules/schedule-expression.ts';

const out: string[] = [];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const [after, count] = line.split('\t', 2);
  const text = line.slice(after.length + count.length + 2);
  try {
    const runs = nextRuns(parseScheduleExpression(text), new Date(Number(after)), Number(count));
    out.push(`runs: ${runs.map((run) => run.getTime()).join(' ')}`);
  } catch (error) {
    if (!(error instanceof InvalidScheduleExpressionError)) throw error;
    out.push(`refused: ${error.message}`);
  }
}
process.stdout.write(out.join('\n') + '\n');

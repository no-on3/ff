/**
 * L1: a function's log lines as GET /functions/:id/logs gives them
 * (client-readiness plan, P-40): a pod's log with timestamps read line by
 * line, each line given the call it belongs to from the runtimes' START,
 * END and REPORT lines, and several instances merged by time.
 */
import { FunctionLogLine } from '../orchestrator.types';
import { MAX_MESSAGE, TRUNCATED, mergeLogs, podLogLines } from './pod-logs';

const POD = 'fn-1-7d9f8b6c5-x2x9q';
/** A pod's log as the API gives it with timestamps=true. */
const log = (...lines: Array<[string, string]>) => lines.map(([time, message]) => `${time} ${message}`).join('\n') + '\n';
const ids = (lines: FunctionLogLine[]) => lines.map((line) => [line.message, line.requestId]);

describe("a function's log lines (L1, P-40)", () => {
  describe("a pod's log", () => {
    it('gives each line its time with nine decimals, which Kubernetes trims, its instance and its text', () => {
      const lines = podLogLines(log(['2026-10-17T10:00:00.5Z', 'one'], ['2026-10-17T10:00:00.123456789Z', 'two  with  spaces '], ['2026-10-17T10:00:01Z', '']), POD);

      expect(lines).toEqual([
        { time: '2026-10-17T10:00:00.500000000Z', instance: POD, requestId: null, message: 'one' },
        { time: '2026-10-17T10:00:00.123456789Z', instance: POD, requestId: null, message: 'two  with  spaces ' },
        { time: '2026-10-17T10:00:01.000000000Z', instance: POD, requestId: null, message: '' },
      ]);
    });

    it('skips what has no time: the empty end, or a line a byte limit cut', () => {
      expect(podLogLines('2026-10-17T10:00:00Z kept\nno time here\n\n2026-10-17T10:00:0', POD).map((line) => line.message)).toEqual(['kept']);
      expect(podLogLines('', POD)).toEqual([]);
    });

    it(`cuts a line longer than ${MAX_MESSAGE} characters, and says so`, () => {
      const [line] = podLogLines(log(['2026-10-17T10:00:00Z', 'x'.repeat(MAX_MESSAGE + 1)]), POD);
      const [kept] = podLogLines(log(['2026-10-17T10:00:00Z', 'y'.repeat(MAX_MESSAGE)]), POD);

      expect([line.message.length, line.message.endsWith(`x${TRUNCATED}`), kept.message.length]).toEqual([MAX_MESSAGE + TRUNCATED.length, true, MAX_MESSAGE]);
    });
  });

  describe('the call of each line', () => {
    it("is the one from its START to its REPORT; a cold start's lines and the runtime's own between calls have none", () => {
      const lines = podLogLines(
        log(
          ['2026-10-17T10:00:00Z', '{"level":"info","msg":"runtime listening","port":8080}'],
          ['2026-10-17T10:00:01Z', 'START RequestId: req-1 Version: $LATEST'],
          ['2026-10-17T10:00:01.1Z', 'Hello from the handler'],
          ['2026-10-17T10:00:01.2Z', 'END RequestId: req-1'],
          ['2026-10-17T10:00:01.3Z', 'a late line of the worker'],
          ['2026-10-17T10:00:01.4Z', 'REPORT RequestId: req-1\tDuration: 2.00 ms\tBilled Duration: 2 ms'],
          ['2026-10-17T10:00:05Z', 'between calls'],
          ['2026-10-17T10:00:06Z', 'START RequestId: req-2 Version: $LATEST'],
          ['2026-10-17T10:00:06.5Z', 'second'],
        ),
        POD,
      );

      expect(ids(lines)).toEqual([
        ['{"level":"info","msg":"runtime listening","port":8080}', null],
        ['START RequestId: req-1 Version: $LATEST', 'req-1'],
        ['Hello from the handler', 'req-1'],
        ['END RequestId: req-1', 'req-1'],
        ['a late line of the worker', 'req-1'],
        ['REPORT RequestId: req-1\tDuration: 2.00 ms\tBilled Duration: 2 ms', 'req-1'],
        ['between calls', null],
        ['START RequestId: req-2 Version: $LATEST', 'req-2'],
        ['second', 'req-2'],
      ]);
    });

    it('is named by its END when the lines read begin inside it', () => {
      const lines = podLogLines(
        log(['2026-10-17T10:00:01Z', 'inside a call'], ['2026-10-17T10:00:02Z', 'END RequestId: req-9'], ['2026-10-17T10:00:03Z', 'REPORT RequestId: req-9\tDuration: 1.00 ms']),
        POD,
      );

      expect(ids(lines).map(([, requestId]) => requestId)).toEqual(['req-9', 'req-9', 'req-9']);
    });

    it('is no call before a first START, as at a cold start', () => {
      expect(ids(podLogLines(log(['2026-10-17T10:00:00Z', 'loading'], ['2026-10-17T10:00:01Z', 'START RequestId: req-1 Version: 1']), POD))).toEqual([
        ['loading', null],
        ['START RequestId: req-1 Version: 1', 'req-1'],
      ]);
    });

    it('reads a marker only at the start of a line: a handler that prints one mid-line names no call', () => {
      expect(ids(podLogLines(log(['2026-10-17T10:00:00Z', 'user said: START RequestId: fake']), POD))).toEqual([['user said: START RequestId: fake', null]]);
    });
  });

  describe('several instances', () => {
    const a = podLogLines(log(['2026-10-17T10:00:00.1Z', 'a1'], ['2026-10-17T10:00:00.3Z', 'a2'], ['2026-10-17T10:00:00.3Z', 'a3']), 'pod-a');
    const b = podLogLines(log(['2026-10-17T10:00:00.2Z', 'b1'], ['2026-10-17T10:00:00.3Z', 'b2'], ['2026-10-17T10:00:00.25Z', 'b-late']), 'pod-b');

    it('merge by time, then by instance; lines of the same time keep their instance\'s order', () => {
      expect(mergeLogs([b, a], 100).map((line) => line.message)).toEqual(['a1', 'b1', 'b-late', 'a2', 'a3', 'b2']);
    });

    it('give the newest `tail` lines, oldest first', () => {
      expect(mergeLogs([a, b], 2).map((line) => line.message)).toEqual(['a3', 'b2']);
      expect(mergeLogs([a, b], 6)).toHaveLength(6);
      expect(mergeLogs([], 10)).toEqual([]);
    });
  });
});

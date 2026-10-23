/**
 * L2 (P-45): what the invocation history keeps, against a real PostgreSQL
 * server, in a scratch database dropped after, through the real invoke path
 * (the orchestrator is a stand-in): at most 64 KiB of each input, output and
 * error, marked when cut, and only what PostgreSQL can store; the caller gets
 * them whole.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionRuntimeError } from '../orchestrator/orchestrator.errors';
import { InvokeResult, Orchestrator } from '../orchestrator/orchestrator.types';
import { UsageRecord } from '../usage/usage-record.entity';
import { UsageService } from '../usage/usage.service';
import { FunctionInvocation, InvocationStatus } from './entities/function-invocation.entity';
import { Function, FunctionStatus, Runtime } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { HISTORY_FIELD_BYTES } from './history';
import { memoryEnvironments, noFunctionKeys, noPackages } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '300000000045';
/** Equal strings, or a failure that names the first difference instead of printing 64 KiB. */
function expectSame(actual: unknown, expected: string): void {
  if (actual === expected) return;
  const text = String(actual);
  let at = 0;
  while (at < Math.min(text.length, expected.length) && text[at] === expected[at]) at++;
  throw new Error(`Strings differ at ${at} (lengths ${text.length} and ${expected.length}): ${JSON.stringify(text.slice(at, at + 20))} instead of ${JSON.stringify(expected.slice(at, at + 20))}`);
}
/** A JSON string value whose JSON text (with its two quotes) is exactly `size` bytes. */
const jsonOfSize = (size: number) => 'a'.repeat(size - 2);

run('the invocation history (L2, P-45)', () => {
  let db: ScratchDatabase;
  let functions: FunctionsService;
  const invoke = jest.fn<Promise<InvokeResult>, Parameters<Orchestrator['invoke']>>();
  let n = 0;

  const invocations = () => db.dataSource.getRepository(FunctionInvocation);
  const records = (requestId: string) => db.dataSource.query<Array<{ status: string }>>('SELECT status FROM usage_records WHERE request_id = $1', [requestId]);
  /** The invocation as the history API reads it back. */
  const inHistory = async (fn: Function, id: string) =>
    (await functions.getInvocations(ACCOUNT, fn.id, { limit: 100, offset: 0 })).invocations.find((invocation) => invocation.id === id);

  async function newFunction(): Promise<Function> {
    return db.dataSource.getRepository(Function).save({
      name: `fn-${++n}`,
      accountId: ACCOUNT,
      runtime: Runtime.NODEJS,
      code: 'export const handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
  }

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save({ id: ACCOUNT, name: 'History', planId: 'beta', status: AccountStatus.ACTIVE });
    const config = { get: (_key: string, fallback?: unknown) => fallback } as unknown as ConfigService;
    const usage = new UsageService(db.dataSource.getRepository(UsageRecord), db.dataSource, config);
    await usage.ensurePartitions();
    functions = new FunctionsService(
      db.dataSource.getRepository(Function),
      invocations(),
      {} as never, // invocations only: no code storage
      { invoke } as unknown as Orchestrator,
      config,
      { invocationStarted: () => undefined, invocationFinished: () => undefined, recordMetric: () => undefined } as never,
      {} as never, // no plans: invocations only
      { record: async () => undefined } as never,
      usage,
      { admit: async () => undefined } as never, // every call admitted
      memoryEnvironments(),
      ...noPackages(),
      noFunctionKeys(),
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    invoke.mockReset();
  });

  it('answers a call whose input and output hold characters PostgreSQL cannot store, NUL and a lone surrogate, and keeps them as U+FFFD', async () => {
    // Before P-45, the input's NUL made the invoke fail with a 500 before the function ran, and the output's lost the answer.
    const fn = await newFunction();
    invoke.mockResolvedValueOnce({ output: { text: 'emoji cut in two \ud83d', nul: 'a\u0000b' }, durationMs: 1, memoryUsedMb: 50 });

    const answered = await functions.invoke(ACCOUNT, fn.id, { name: 'x\u0000y' });

    expect(invoke.mock.calls[0][1]).toEqual({ name: 'x\u0000y' }); // the function gets its input as sent
    expect(answered.output).toEqual({ text: 'emoji cut in two \ud83d', nul: 'a\u0000b' });
    expect(await inHistory(fn, answered.id)).toMatchObject({
      status: InvocationStatus.COMPLETED,
      input: { name: 'x\ufffdy' },
      output: { text: 'emoji cut in two \ufffd', nul: 'a\ufffdb' },
      inputTruncated: false,
      outputTruncated: false,
    });
    expect(await records(answered.id)).toEqual([{ status: 'success' }]);
  });

  it('keeps the first 64 KiB of an input and an output longer than that, marked truncated, and answers both whole', async () => {
    const fn = await newFunction();
    const input = { file: 'é'.repeat(HISTORY_FIELD_BYTES) };
    const output = { rows: Array.from({ length: 20_000 }, (_, i) => ({ i, name: `row ${i}` })) };
    invoke.mockResolvedValueOnce({ output, durationMs: 3, memoryUsedMb: 60 });

    const answered = await functions.invoke(ACCOUNT, fn.id, input);

    expect(answered).toMatchObject({ inputTruncated: true, outputTruncated: true });
    expect(answered.input === input && answered.output === output).toBe(true); // the very values, whole
    const kept = await inHistory(fn, answered.id);
    expect(kept).toMatchObject({ status: InvocationStatus.COMPLETED, inputTruncated: true, outputTruncated: true, errorTruncated: false });
    // `{"file":"`, 9 bytes, then as many whole é's, 2 bytes each, as fit: 65,535 bytes in all.
    expectSame(kept?.input, JSON.stringify(input).slice(0, 9 + Math.floor((HISTORY_FIELD_BYTES - 9) / 2)));
    expect(Buffer.byteLength(kept?.input as string)).toBe(HISTORY_FIELD_BYTES - 1);
    expectSame(kept?.output, JSON.stringify(output).slice(0, HISTORY_FIELD_BYTES));
    const [{ bytes }] = await db.dataSource.query<Array<{ bytes: number }>>(
      'SELECT octet_length(input #>> \'{}\') + octet_length(output #>> \'{}\') AS bytes FROM function_invocations WHERE id = $1',
      [answered.id],
    );
    expect(bytes).toBe(2 * HISTORY_FIELD_BYTES - 1);
  });

  it('keeps an input and an output of exactly 64 KiB whole', async () => {
    const fn = await newFunction();
    const exact = jsonOfSize(HISTORY_FIELD_BYTES);
    invoke.mockResolvedValueOnce({ output: exact, durationMs: 1, memoryUsedMb: 50 });

    const answered = await functions.invoke(ACCOUNT, fn.id, { s: jsonOfSize(HISTORY_FIELD_BYTES - '{"s":}'.length) });

    const kept = await inHistory(fn, answered.id);
    expect(kept).toMatchObject({ inputTruncated: false, outputTruncated: false });
    expectSame(kept?.output, exact);
  });

  it("keeps the first 64 KiB of a function's error, NUL as U+FFFD, and the caller's 400 has it whole", async () => {
    const fn = await newFunction();
    const message = 'bad row\u0000 ' + '€'.repeat(HISTORY_FIELD_BYTES);
    invoke.mockRejectedValueOnce(new FunctionRuntimeError('ValidationError', message, { durationMs: 2, memoryUsedMb: 55 }));

    const refusal = await functions.invoke(ACCOUNT, fn.id, {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).message).toBe(`ValidationError: ${message}`);
    const [kept] = (await functions.getInvocations(ACCOUNT, fn.id, { limit: 1, offset: 0 })).invocations;
    expect(kept).toMatchObject({ status: InvocationStatus.ERROR, errorTruncated: true, inputTruncated: false, outputTruncated: false });
    const start = 'ValidationError: bad row\ufffd ';
    expectSame(kept.error, start + '€'.repeat(Math.floor((HISTORY_FIELD_BYTES - Buffer.byteLength(start)) / 3)));
    expect(Buffer.byteLength(kept.error as string)).toBeLessThanOrEqual(HISTORY_FIELD_BYTES);
    expect(await records(kept.id)).toEqual([{ status: 'error' }]);
  });
});

/**
 * L1: TypeORM's lines through the backend's logger. TypeORM's own logger
 * writes to the console directly, so in a JSON log its query lines were the
 * ones that weren't JSON. Through Nest's logger they take the log's format,
 * and what is logged stays what the `logging` setting says.
 */
import { Logger } from '@nestjs/common';
import { TypeOrmLogger } from './typeorm-logger';

describe("TypeORM's lines through the backend's logger", () => {
  let written: Array<[string, string, string | undefined]>;

  beforeEach(() => {
    written = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(function (this: Logger, message: unknown) {
        written.push([level, String(message), (this as unknown as { context?: string }).context]);
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it('writes each query with its parameters, as plain text, as TypeORM would in development', () => {
    new TypeOrmLogger(true).logQuery('SELECT "id" FROM "functions" WHERE "account_id" = $1', ['000000000001']);

    expect(written).toEqual([['log', 'query: SELECT "id" FROM "functions" WHERE "account_id" = $1 -- PARAMETERS: ["000000000001"]', 'TypeORM']]);
    expect(written[0][1]).not.toContain('\u001b['); // no colours in a JSON string
  });

  it('writes a failed query and its error as errors, and a slow one as a warning', () => {
    const logger = new TypeOrmLogger(['error', 'warn']);
    logger.logQueryError('duplicate key value violates unique constraint "PK_functions"', 'INSERT INTO "functions" ("id") VALUES ($1)', ['f-1']);
    logger.logQuerySlow(2400, 'SELECT count(*) FROM "usage_records"');

    expect(written).toEqual([
      ['error', 'query failed: INSERT INTO "functions" ("id") VALUES ($1) -- PARAMETERS: ["f-1"]', 'TypeORM'],
      ['error', 'error: duplicate key value violates unique constraint "PK_functions"', 'TypeORM'],
      ['warn', 'query is slow: SELECT count(*) FROM "usage_records"', 'TypeORM'],
      ['warn', 'execution time: 2400', 'TypeORM'],
    ]);
  });

  it('writes nothing when logging is off, as in production: not even a failed query, which the code answers for', () => {
    const logger = new TypeOrmLogger(false);
    logger.logQuery('SELECT 1');
    logger.logQueryError('connection terminated', 'SELECT 1');
    logger.log('warn', 'the pool is full');

    expect(written).toEqual([]);
  });
});

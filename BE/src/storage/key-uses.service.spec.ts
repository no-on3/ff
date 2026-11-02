import { Logger } from '@nestjs/common';
import { AwsEndpoint } from '../common/aws-endpoint';
import { KeyUse } from './key-use.entity';
import { KeyUses, NotedUse } from './key-uses.service';
import { Repository } from 'typeorm';

const ACCOUNT = '000000000001';
const FUNCTION = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const ACCOUNTS_KEY = { id: 'AKFFAAAAAAAAAAAAAAAA', accountId: ACCOUNT, functionId: null };
const FUNCTIONS_KEY = { id: 'AKFFBBBBBBBBBBBBBBBB', accountId: ACCOUNT, functionId: FUNCTION };
const use = (key: NotedUse['key'], operation = 'GetObject', resource = 'photos', service = AwsEndpoint.S3): NotedUse => ({ key, service, resource, operation });
const at = (day: string) => new Date(`${day}T12:00:00Z`);

/** The rows of each statement the repository was given: its parameters, seven to a row, as columns. */
function written(query: jest.Mock): Array<Array<Record<string, string>>> {
  return query.mock.calls.map(([, params]: [string, string[]]) => {
    const rows: Array<Record<string, string>> = [];
    for (let i = 0; i < params.length; i += 7) {
      const [holder, service, resource, operation, accountId, firstDay, lastDay] = params.slice(i, i + 7);
      rows.push({ holder, service, resource, operation, accountId, firstDay, lastDay });
    }
    return rows;
  });
}

describe("what the account's keys use, noted once a day and written at the minute's turn", () => {
  let query: jest.Mock;
  let uses: KeyUses;

  beforeEach(() => {
    query = jest.fn(async () => []);
    uses = new KeyUses({ query } as unknown as Repository<KeyUse>);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("writes each use once a day: a function's keys under the function, so that its uses stay together when its key is replaced, the account's under the key", async () => {
    const replaced = { ...FUNCTIONS_KEY, id: 'AKFFCCCCCCCCCCCCCCCC' };
    for (let n = 0; n < 3; n++) uses.note(use(ACCOUNTS_KEY), at('2026-10-31'));
    uses.note(use(FUNCTIONS_KEY, 'SendMessage', 'orders', AwsEndpoint.SQS), at('2026-10-31'));
    uses.note(use(replaced, 'SendMessage', 'orders', AwsEndpoint.SQS), at('2026-10-31'));

    expect(await uses.flush()).toBe(2);
    expect(await uses.flush()).toBe(0);

    expect(written(query)).toEqual([
      [
        { holder: ACCOUNTS_KEY.id, service: 's3', resource: 'photos', operation: 'GetObject', accountId: ACCOUNT, firstDay: '2026-10-31', lastDay: '2026-10-31' },
        { holder: FUNCTION, service: 'sqs', resource: 'orders', operation: 'SendMessage', accountId: ACCOUNT, firstDay: '2026-10-31', lastDay: '2026-10-31' },
      ],
    ]);
    // A row's first day stays and its last moves on, never back: every backend writes what it saw.
    expect(query.mock.calls[0][0]).toMatch(/ON CONFLICT \("holder", "service", "resource", "operation"\) DO UPDATE\s+SET "first_day" = LEAST\(.*\), "last_day" = GREATEST\(/);
  });

  it('notes a use again the next day, UTC, and each operation and resource apart', async () => {
    uses.note(use(ACCOUNTS_KEY), at('2026-10-31'));
    await uses.flush();
    uses.note(use(ACCOUNTS_KEY), new Date('2026-10-31T23:59:59Z'));
    uses.note(use(ACCOUNTS_KEY), new Date('2026-11-01T00:00:00Z'));
    uses.note(use(ACCOUNTS_KEY, 'PutObject'), new Date('2026-11-01T00:00:01Z'));
    uses.note(use(ACCOUNTS_KEY, 'GetObject', 'exports'), new Date('2026-11-01T00:00:02Z'));
    await uses.flush();

    expect(written(query).map((rows) => rows.map((row) => `${row.operation} ${row.resource} ${row.lastDay}`))).toEqual([
      ['GetObject photos 2026-10-31'],
      ['GetObject photos 2026-11-01', 'PutObject photos 2026-11-01', 'GetObject exports 2026-11-01'],
    ]);
  });

  it("keeps what it couldn't write for the next turn, saying so, and keeps its first day when the same use comes the day after", async () => {
    query.mockRejectedValueOnce(new Error('the database is away'));
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    uses.note(use(ACCOUNTS_KEY), at('2026-10-31'));

    expect(await uses.flush()).toBe(0);
    uses.note(use(ACCOUNTS_KEY), at('2026-11-01'));
    expect(await uses.flush()).toBe(1);

    expect(warned).toHaveBeenCalledWith("Could not write 1 use(s) of the account's keys, kept for the next try: the database is away");
    expect(written(query).at(-1)).toEqual([expect.objectContaining({ holder: ACCOUNTS_KEY.id, firstDay: '2026-10-31', lastDay: '2026-11-01' })]);
  });

  it('writes nothing when nothing was noted, and 500 rows a statement at most', async () => {
    expect(await uses.flush()).toBe(0);
    expect(query).not.toHaveBeenCalled();

    for (let n = 0; n < 501; n++) uses.note(use(ACCOUNTS_KEY, 'GetObject', `bucket-${n}`), at('2026-10-31'));
    expect(await uses.flush()).toBe(501);

    expect(written(query).map((rows) => rows.length)).toEqual([500, 1]);
  });

  it('writes what is left when the backend stops', async () => {
    uses.note(use(FUNCTIONS_KEY, 'SendEmail', 'orders@shop.example.tn', AwsEndpoint.SESV2), at('2026-10-31'));

    await uses.onModuleDestroy();

    expect(written(query)).toEqual([[expect.objectContaining({ holder: FUNCTION, service: 'sesv2', resource: 'orders@shop.example.tn', operation: 'SendEmail' })]]);
  });
});

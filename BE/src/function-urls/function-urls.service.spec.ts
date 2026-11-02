/**
 * L1: functions' URLs, as their accounts give, read, change and delete them:
 * one for $LATEST and one for each alias, at a random address under the
 * function domain, never for what takes the wrapped event, each change in the
 * audit log.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FindOperator, QueryFailedError } from 'typeorm';
import { FunctionAlias } from '../functions/entities/function-alias.entity';
import { FunctionUrl, UrlAuthType, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { FunctionVersion } from '../functions/entities/function-version.entity';
import { EventFormat } from '../functions/entities/function.entity';
import { FunctionUrlsService, WRAPPED_FUNCTION_REFUSAL } from './function-urls.service';

const ACCOUNT = '123456789012';
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

/** Whether a row is one a TypeORM where finds: its values, null for IsNull(), one of In()'s. */
function matches<T>(row: T, where: Partial<Record<keyof T, unknown>>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const field = row[key as keyof T];
    if (!(value instanceof FindOperator)) return field === value;
    if (value.type === 'isNull') return field === null;
    if (value.type === 'in') return (value.value as unknown[]).includes(field);
    throw new Error(`The stand-in reads no ${value.type}`);
  });
}

describe('FunctionUrlsService (L1)', () => {
  let service: FunctionUrlsService;
  /** By their IDs. */
  let rows: Map<string, FunctionUrl>;
  let aliases: Array<Partial<FunctionAlias>>;
  let versions: Array<Partial<FunctionVersion>>;
  let eventFormat: EventFormat;
  const audit = { record: jest.fn() };
  const functions = { findOne: jest.fn() };
  const tableOf = (entity: unknown) => (entity === FunctionAlias ? aliases : versions) as Array<Record<string, unknown>>;
  const repository = {
    create: (values: Partial<FunctionUrl>) => ({ ...values }) as FunctionUrl,
    existsBy: jest.fn(async (where: Partial<FunctionUrl>) => [...rows.values()].some((url) => matches(url, where))),
    find: jest.fn(async ({ where }: { where: Partial<FunctionUrl> }) => [...rows.values()].filter((url) => matches(url, where))),
    findOne: jest.fn(async ({ where }: { where: Partial<FunctionUrl> }) => {
      const row = [...rows.values()].find((url) => matches(url, where));
      return row ? { ...row } : null;
    }),
    insert: jest.fn(async (url: FunctionUrl) => {
      // As the database fills them in, and TypeORM copies them back.
      Object.assign(url, { createdAt: new Date('2026-10-21T08:00:00Z'), updatedAt: new Date('2026-10-21T08:00:00Z') });
      rows.set(url.urlId, { ...url });
    }),
    save: jest.fn(async (url: FunctionUrl) => {
      const saved = { ...url, updatedAt: new Date('2026-10-21T09:00:00Z') };
      rows.set(url.urlId, saved);
      return saved;
    }),
    delete: jest.fn(async ({ urlId }: { urlId: string }) => rows.delete(urlId)),
    manager: {
      findOne: jest.fn(async (entity: unknown, { where }: { where: Record<string, unknown> }) => tableOf(entity).find((row) => matches(row, where)) ?? null),
      existsBy: jest.fn(async (entity: unknown, where: Record<string, unknown>) => tableOf(entity).some((row) => matches(row, where))),
    },
  };
  const latestOf = () => [...rows.values()].find((url) => url.alias === null);

  beforeEach(() => {
    jest.clearAllMocks();
    rows = new Map();
    aliases = [
      { functionId: FN, name: 'live', version: 2, additionalVersion: 3 },
      { functionId: FN, name: 'edge', version: null, additionalVersion: null },
    ];
    versions = [
      { functionId: FN, version: 2, eventFormat: EventFormat.LAMBDA },
      { functionId: FN, version: 3, eventFormat: EventFormat.LAMBDA },
    ];
    eventFormat = EventFormat.LAMBDA;
    functions.findOne.mockImplementation(async (accountId: string, id: string) => {
      if (accountId !== ACCOUNT || id !== FN) throw new NotFoundException(`Function with ID ${id} not found`);
      return { id, name: 'orders', accountId, eventFormat };
    });
    service = new FunctionUrlsService(
      repository as never,
      functions as never,
      audit as never,
      { getOrThrow: () => 'https://fn.example.tn' } as unknown as ConfigService,
    );
  });

  it('gives the function a URL at a new random address under the function domain, and records it', async () => {
    const url = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE });

    expect(url).toEqual({
      functionUrl: expect.stringMatching(/^https:\/\/[a-z0-9]{32}\.fn\.example\.tn\/$/),
      functionId: FN,
      alias: null,
      authType: UrlAuthType.NONE,
      cors: null,
      invokeMode: UrlInvokeMode.BUFFERED,
      createdAt: new Date('2026-10-21T08:00:00Z'),
      updatedAt: new Date('2026-10-21T08:00:00Z'),
    });
    expect(latestOf()).toMatchObject({ accountId: ACCOUNT, urlId: url.functionUrl.slice(8, 40) });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      action: 'function_url.create',
      resource: `function:${FN}`,
      details: { authType: UrlAuthType.NONE, cors: false },
    });
  });

  it('keeps the CORS fields given, and only those', async () => {
    const url = await service.create(ACCOUNT, FN, { authType: UrlAuthType.AWS_IAM, cors: { allowOrigins: ['https://app.example.tn'], maxAge: 0 } });

    expect(url.cors).toEqual({ allowOrigins: ['https://app.example.tn'], maxAge: 0 });
  });

  it("refuses a URL to a function that takes FF's original wrapped event, saying how to switch", async () => {
    eventFormat = EventFormat.WRAPPED;

    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE })).rejects.toThrow(new BadRequestException(WRAPPED_FUNCTION_REFUSAL));
    expect(rows.size).toBe(0);
  });

  it('refuses a second URL, also when another request gave it one meanwhile', async () => {
    await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE });
    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE })).rejects.toBeInstanceOf(ConflictException);

    repository.existsBy.mockResolvedValueOnce(false);
    repository.insert.mockRejectedValueOnce(new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' })));
    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE })).rejects.toBeInstanceOf(ConflictException);
  });

  it("finds neither another account's function nor a URL that doesn't exist", async () => {
    await expect(service.get('999999999999', FN)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.get(ACCOUNT, FN)).rejects.toThrow(`Function ${FN} has no URL: create one with POST /functions/${FN}/url`);
  });

  it("gives each alias a URL of its own, beside $LATEST's, at another address, each once; lists them $LATEST's first", async () => {
    const latest = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE });
    const live = await service.create(ACCOUNT, FN, { authType: UrlAuthType.AWS_IAM }, 'live');
    const edge = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE }, 'edge');

    expect([live.alias, live.authType, live.functionUrl === latest.functionUrl]).toEqual(['live', UrlAuthType.AWS_IAM, false]);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'function_url.create', details: { alias: 'live', authType: UrlAuthType.AWS_IAM, cors: false } }));
    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE }, 'live')).rejects.toThrow(
      new ConflictException('The alias live already has a URL, and an alias has one at most: change it with PUT, or delete it first'),
    );
    expect((await service.list(ACCOUNT, FN)).map((url) => [url.alias, url.functionUrl])).toEqual([
      [null, latest.functionUrl],
      ['edge', edge.functionUrl],
      ['live', live.functionUrl],
    ]);
    // The platform's support page reads them by the function alone, in the same order.
    expect((await service.ofFunction(FN)).map((url) => url.alias)).toEqual([null, 'edge', 'live']);
  });

  it("refuses an alias the function hasn't, and one whose version, the other included, or $LATEST takes the wrapped event", async () => {
    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE }, 'gone')).rejects.toThrow(
      new NotFoundException('The function orders has no alias gone: GET /functions/{id}/aliases lists them'),
    );
    versions[1].eventFormat = EventFormat.WRAPPED;
    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE }, 'live')).rejects.toThrow(
      "A function URL sends AWS Lambda's events, and the alias live names version 3, which takes FF's original wrapped event: " +
        'point the alias at a version published with eventFormat lambda, then create its URL',
    );
    eventFormat = EventFormat.WRAPPED;
    await expect(service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE }, 'edge')).rejects.toThrow('and the alias edge names $LATEST, which takes');
    expect(rows.size).toBe(0);
  });

  it("reads, changes and deletes an alias's URL by the alias, $LATEST's staying; the 404s say what is missing", async () => {
    await expect(service.get(ACCOUNT, FN, 'live')).rejects.toThrow(`The alias live has no URL: create one with POST /functions/${FN}/url?qualifier=live`);
    await expect(service.get(ACCOUNT, FN, 'gone')).rejects.toThrow('The function orders has no alias gone');
    const latest = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE });
    const live = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE }, 'live');

    expect((await service.update(ACCOUNT, FN, { authType: UrlAuthType.AWS_IAM }, 'live')).authType).toBe(UrlAuthType.AWS_IAM);
    expect([(await service.get(ACCOUNT, FN)).authType, (await service.get(ACCOUNT, FN, 'live')).functionUrl]).toEqual([UrlAuthType.NONE, live.functionUrl]);
    await service.remove(ACCOUNT, FN, 'live');

    expect([...rows.values()].map((url) => url.alias)).toEqual([null]);
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'function_url.delete', details: { alias: 'live', functionUrl: live.functionUrl } }));
    expect((await service.get(ACCOUNT, FN)).functionUrl).toBe(latest.functionUrl);
  });

  it('changes what is given, keeps the rest and the address; null removes CORS', async () => {
    const created = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE, cors: { allowOrigins: ['*'] } });

    const changed = await service.update(ACCOUNT, FN, { authType: UrlAuthType.AWS_IAM });
    expect([changed.functionUrl, changed.authType, changed.cors]).toEqual([created.functionUrl, UrlAuthType.AWS_IAM, { allowOrigins: ['*'] }]);

    const withoutCors = await service.update(ACCOUNT, FN, { cors: null });
    expect([withoutCors.authType, withoutCors.cors]).toEqual([UrlAuthType.AWS_IAM, null]);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'function_url.update', details: { changed: ['cors'], authType: UrlAuthType.AWS_IAM, cors: false } }),
    );
  });

  it('saves and records nothing when nothing changes', async () => {
    await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE });
    audit.record.mockClear();

    await service.update(ACCOUNT, FN, { authType: UrlAuthType.NONE, cors: null, invokeMode: UrlInvokeMode.BUFFERED });

    expect(repository.save).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('deletes the URL, recording the address that stops answering', async () => {
    const created = await service.create(ACCOUNT, FN, { authType: UrlAuthType.NONE });

    await service.remove(ACCOUNT, FN);

    expect(rows.size).toBe(0);
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'function_url.delete', details: { functionUrl: created.functionUrl } }));
    await expect(service.remove(ACCOUNT, FN)).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * L1: functions' URLs, as their accounts give, read, change and delete them:
 * one per function, at a random address under the function domain, never for
 * a function that takes the wrapped event, each change in the audit log.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { FunctionUrl, UrlAuthType, UrlInvokeMode } from '../functions/entities/function-url.entity';
import { EventFormat } from '../functions/entities/function.entity';
import { FunctionUrlsService, WRAPPED_FUNCTION_REFUSAL } from './function-urls.service';

const ACCOUNT = '123456789012';
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

describe('FunctionUrlsService (L1)', () => {
  let service: FunctionUrlsService;
  let rows: Map<string, FunctionUrl>;
  let eventFormat: EventFormat;
  const audit = { record: jest.fn() };
  const functions = { findOne: jest.fn() };
  const repository = {
    create: (values: Partial<FunctionUrl>) => ({ ...values }) as FunctionUrl,
    existsBy: jest.fn(async (where: { functionId: string }) => rows.has(where.functionId)),
    findOne: jest.fn(async ({ where }: { where: Partial<FunctionUrl> }) => {
      const row = [...rows.values()].find((url) => Object.entries(where).every(([key, value]) => url[key as keyof FunctionUrl] === value));
      return row ? { ...row } : null;
    }),
    insert: jest.fn(async (url: FunctionUrl) => {
      // As the database fills them in, and TypeORM copies them back.
      Object.assign(url, { createdAt: new Date('2026-10-21T08:00:00Z'), updatedAt: new Date('2026-10-21T08:00:00Z') });
      rows.set(url.functionId, { ...url });
    }),
    save: jest.fn(async (url: FunctionUrl) => {
      const saved = { ...url, updatedAt: new Date('2026-10-21T09:00:00Z') };
      rows.set(url.functionId, saved);
      return saved;
    }),
    delete: jest.fn(async ({ functionId }: { functionId: string }) => rows.delete(functionId)),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rows = new Map();
    eventFormat = EventFormat.LAMBDA;
    functions.findOne.mockImplementation(async (accountId: string, id: string) => {
      if (accountId !== ACCOUNT || id !== FN) throw new NotFoundException(`Function with ID ${id} not found`);
      return { id, accountId, eventFormat };
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
      authType: UrlAuthType.NONE,
      cors: null,
      invokeMode: UrlInvokeMode.BUFFERED,
      createdAt: new Date('2026-10-21T08:00:00Z'),
      updatedAt: new Date('2026-10-21T08:00:00Z'),
    });
    expect(rows.get(FN)).toMatchObject({ accountId: ACCOUNT, urlId: url.functionUrl.slice(8, 40) });
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

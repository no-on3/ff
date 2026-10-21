import { HttpException, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { QueryFailedError } from 'typeorm';
import { PACKAGE_LIMITS } from './package-archive';
import { Package, packageKey } from './package.entity';
import { MAX_UNUSED_PACKAGES, PackagesService } from './packages.service';
import { zipOf } from './test-fixtures';

const ACCOUNT = '123456789012';
const ZIP = zipOf([
  { name: 'src/app.js', data: 'exports.handler = async () => 1;\n' },
  { name: 'node_modules/left-pad/index.js', data: 'module.exports = (s) => s;\n' },
]);
const SHA = createHash('sha256').update(ZIP).digest('base64');
const SAVED: Package = {
  id: 'p-1',
  accountId: ACCOUNT,
  codeSha256: SHA,
  codeSize: ZIP.length,
  unpackedSize: 60,
  fileCount: 2,
  files: [],
  imageDigest: null,
  createdAt: new Date('2026-10-21T12:00:00Z'),
  usedAt: new Date('2026-10-21T12:00:00Z'),
};

/** The temporary files of uploads in the system's folder. */
const temporaryFiles = () => readdirSync(tmpdir()).filter((name) => name.startsWith('ff-package-'));

describe("PackagesService: a function's package, uploaded", () => {
  let service: PackagesService;
  let found: Package | null;
  let unused: number;
  /** Those there before the test: an upload leaves none of its own, whatever happens. */
  let before: string[];
  const leftovers = () => temporaryFiles().filter((name) => !before.includes(name));
  const insert = jest.fn();
  const repository = {
    update: jest.fn(),
    findOneBy: jest.fn(async () => found),
    find: jest.fn(async () => (found ? [found] : [])),
    query: jest.fn(async () => [{ unused }]),
    manager: { transaction: jest.fn(async (work: (manager: unknown) => Promise<unknown>) => work({ insert })) },
  };
  const storage = { putFile: jest.fn(), deleteObject: jest.fn() };
  const audit = { record: jest.fn() };
  const images = { deleteImage: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    found = null;
    unused = 0;
    before = temporaryFiles();
    // What the database answers once the row is in.
    insert.mockImplementation(async () => {
      found = SAVED;
    });
    service = new PackagesService(repository as never, storage as never, audit as never, images as never);
  });

  const upload = (body: Readable | Buffer, contentType = 'application/zip', contentLength?: number) =>
    service.upload(ACCOUNT, Buffer.isBuffer(body) ? Readable.from([body]) : body, contentType, contentLength);
  const refusal = async (attempt: Promise<unknown>) => {
    const error = await attempt.then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(HttpException);
    return [(error as HttpException).getStatus(), (error as HttpException).message];
  };
  const nothingKept = () => {
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  };

  it('stores a new package under its account and SHA-256, keeps its files, and records the upload once', async () => {
    const result = await upload(ZIP, 'application/zip; charset=binary', ZIP.length);

    expect(result).toEqual({ created: true, package: { codeSha256: SHA, codeSize: ZIP.length, unpackedSize: 60, fileCount: 2, createdAt: SAVED.createdAt } });
    expect(storage.putFile).toHaveBeenCalledWith(packageKey(ACCOUNT, SHA), expect.stringMatching(/ff-package-[0-9a-f-]{36}\.zip$/), ZIP.length, 'application/zip');
    expect(insert).toHaveBeenCalledWith(Package, {
      accountId: ACCOUNT,
      codeSha256: SHA,
      codeSize: ZIP.length,
      unpackedSize: 33 + 27,
      fileCount: 2,
      files: ['node_modules/left-pad/index.js', 'src/app.js'],
    });
    expect(audit.record).toHaveBeenCalledWith(
      { accountId: ACCOUNT, action: 'package.upload', resource: `package:${SHA}`, details: { codeSha256: SHA, codeSize: ZIP.length, unpackedSize: 60, files: 2 } },
      expect.anything(),
    );
    // Stored before it is recorded: a row never names bytes object storage hasn't.
    expect(storage.putFile.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
    expect(packageKey(ACCOUNT, SHA)).toBe(`packages/${ACCOUNT}/${Buffer.from(SHA, 'base64').toString('hex')}.zip`);
    expect(leftovers()).toEqual([]);
  });

  it('answers a package the account has already, as it is, without checking or storing it again, and keeps it another hour', async () => {
    found = SAVED;

    const result = await upload(ZIP);

    expect(result.created).toBe(false);
    expect(result.package.codeSha256).toBe(SHA);
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith({ accountId: ACCOUNT, codeSha256: SHA }, { usedAt: expect.any(Function) });
  });

  it('answers the package another request recorded meanwhile, the same bytes: the account has it once', async () => {
    insert.mockImplementation(async () => {
      found = SAVED;
      throw new QueryFailedError('INSERT INTO packages', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
    });

    expect(await upload(ZIP)).toMatchObject({ created: false, package: { codeSha256: SHA } });
  });

  it.each([
    ['application/json', 'Send the package as the body, a zip archive, with Content-Type: application/zip, not application/json'],
    [undefined, 'Send the package as the body, a zip archive, with Content-Type: application/zip'],
  ])('refuses %s with 415, reading nothing', async (contentType, message) => {
    const body = new PassThrough();

    const error = await service.upload(ACCOUNT, body, contentType).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(UnsupportedMediaTypeException);
    expect((error as Error).message).toBe(message);
    expect(body.readableFlowing).toBeNull();
    nothingKept();
  });

  it('takes the other types a zip comes as: Windows tools send application/x-zip-compressed, others plain bytes', async () => {
    expect((await upload(ZIP, 'application/x-zip-compressed')).created).toBe(true);
    found = null;
    expect((await upload(ZIP, 'application/octet-stream')).created).toBe(true);
  });

  it("refuses a body over 50 MB, AWS Lambda's limit for a direct upload: by its Content-Length before reading it, else as it comes", async () => {
    const message = 'A package may have 52,428,800 bytes (50 MB) at most, as AWS Lambda takes one uploaded directly';
    expect(await refusal(upload(new PassThrough(), 'application/zip', 52_428_801))).toEqual([413, message]);

    jest.replaceProperty(PACKAGE_LIMITS, 'zipBytes', 1000);
    const chunked = Readable.from([Buffer.alloc(600), Buffer.alloc(600)]);
    const error = await upload(chunked).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PayloadTooLargeException);
    nothingKept();
  });

  it('refuses an empty body, and one cut off before its end', async () => {
    expect(await refusal(upload(Buffer.alloc(0)))).toEqual([400, 'The body is empty: send the package, a zip archive']);
    const cut = new Readable({
      read() {
        this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      },
    });
    expect(await refusal(upload(cut))).toEqual([400, 'The upload stopped before the end of the package']);
    nothingKept();
  });

  it('refuses what the archive check refuses, with its reason, keeping nothing', async () => {
    expect(await refusal(upload(zipOf([{ name: '../app.js', data: 'x' }])))).toEqual([
      400,
      "The package can't be read: ../app.js leaves the package with ..: a package's names stay inside it",
    ]);
    expect(await refusal(upload(Buffer.from('not a zip')))).toEqual([400, expect.stringMatching(/^The package isn't a zip archive FF can read: /)]);
    nothingKept();
  });

  it(`refuses a new package while the account keeps ${MAX_UNUSED_PACKAGES} that no function names, saying how to go on`, async () => {
    unused = MAX_UNUSED_PACKAGES;

    expect(await refusal(upload(ZIP))).toEqual([
      400,
      'The account has 20 packages that no function names, 20 at most: name one in a function, or upload this one once those are deleted, within an hour of their upload',
    ]);
    nothingKept();
    // One it has already is no new package.
    found = SAVED;
    expect((await upload(ZIP)).created).toBe(false);
  });

  it('lists the account\'s packages, newest first, or the one of a SHA-256, without their files', async () => {
    found = SAVED;

    expect(await service.list(ACCOUNT, SHA)).toEqual([{ codeSha256: SHA, codeSize: ZIP.length, unpackedSize: 60, fileCount: 2, createdAt: SAVED.createdAt }]);
    expect(repository.find).toHaveBeenCalledWith({ where: { accountId: ACCOUNT, codeSha256: SHA }, order: { createdAt: 'DESC' } });
    await service.list(ACCOUNT);
    expect(repository.find).toHaveBeenLastCalledWith({ where: { accountId: ACCOUNT }, order: { createdAt: 'DESC' } });
  });
});

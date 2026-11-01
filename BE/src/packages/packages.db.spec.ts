/**
 * L2: functions' packages on a real PostgreSQL: an account has each package
 * once, however many uploads, two at once included, and the audit log says so
 * once; its files are kept; the unused ones, which no function of the account
 * names, are counted and purged after an hour with their zips; the one-file
 * packages the backend makes of inline code are kept while a function names
 * them, as no upload; those functions name are listed for the restore of lost
 * code images; and a closed account's go. Each run works in a scratch
 * database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Runtime } from '../functions/entities/function.entity';
import { inlinePackage } from '../functions/inline-package';
import { Package, packageKey } from './package.entity';
import { MAX_UNUSED_PACKAGES, PackagesService } from './packages.service';
import { zipOf } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run("functions' packages (L2)", () => {
  let db: ScratchDatabase;
  let packages: PackagesService;
  let accounts = 0;
  /** What object storage holds: each zip's key and size. */
  const stored = new Map<string, number>();
  const storage = {
    putFile: jest.fn(async (key: string, _file: string, size: number) => void stored.set(key, size)),
    putDocument: jest.fn(async (key: string, body: Buffer) => void stored.set(key, body.length)),
    deleteObject: jest.fn(async (key: string) => void stored.delete(key)),
  };
  const images = { deleteImage: jest.fn(async (_accountId: string, _digest: string) => undefined) };

  const query = <T = unknown>(sql: string, parameters?: unknown[]) => db.dataSource.query<T>(sql, parameters);
  /** A new account of its own for each test. */
  const account = async (): Promise<string> => {
    const id = `50000000${String(++accounts).padStart(4, '0')}`;
    await db.dataSource.getRepository(Account).save({ id, name: `Packages ${accounts}`, planId: 'beta', status: AccountStatus.ACTIVE });
    return id;
  };
  const zip = (code: string) => zipOf([{ name: 'app.js', data: code }, { name: 'lib/util.js', data: '// util' }]);
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64');
  const upload = (accountId: string, bytes: Buffer) => packages.upload(accountId, Readable.from([bytes]), 'application/zip', bytes.length);
  const rowsOf = async (accountId: string) =>
    (await query<Array<{ code_sha256: string }>>('SELECT code_sha256 FROM packages WHERE account_id = $1 ORDER BY code_sha256', [accountId])).map((row) => row.code_sha256);
  const uploadsAudited = async (accountId: string) =>
    (await query<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'package.upload'`, [accountId]))[0].n;
  /** A zip function of the account naming the package, as a function made from it will. */
  const named = (accountId: string, codeSha256: string, name = 'zipped') =>
    query(
      `INSERT INTO functions (name, account_id, runtime, code, package_type, code_sha256, code_size, memory, timeout) VALUES ($1, $2, 'nodejs', '', 'zip', $3, 100, 128, 5)`,
      [name, accountId, codeSha256],
    );
  /** Uploaded, or last named by a function, `minutes` ago. */
  const usedAgo = (accountId: string, codeSha256: string, minutes: number) =>
    query(`UPDATE packages SET used_at = now() - make_interval(mins => $3) WHERE account_id = $1 AND code_sha256 = $2`, [accountId, codeSha256, minutes]);
  const usedAt = async (accountId: string, codeSha256: string) =>
    (await query<Array<{ minutes: number }>>(`SELECT extract(epoch FROM now() - used_at)::int / 60 AS minutes FROM packages WHERE account_id = $1 AND code_sha256 = $2`, [accountId, codeSha256]))[0].minutes;

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    packages = new PackagesService(db.dataSource.getRepository(Package), storage as never, new AuditService(db.dataSource.getRepository(AuditEntry)), images as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.drop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps a package once per account, uploaded again or by two requests at once, and records its upload once', async () => {
    const a = await account();
    const b = await account();
    const first = zip('exports.handler = async () => 1;');
    const second = zip('exports.handler = async () => 2;');

    expect([(await upload(a, first)).created, (await upload(a, first)).created]).toEqual([true, false]);
    const together = await Promise.all([upload(a, second), upload(a, second)]);
    expect(together.map((result) => result.created).sort()).toEqual([false, true]);
    // Another account's is its own.
    expect((await upload(b, first)).created).toBe(true);

    expect(await rowsOf(a)).toEqual([sha(first), sha(second)].sort());
    expect(await rowsOf(b)).toEqual([sha(first)]);
    expect([await uploadsAudited(a), await uploadsAudited(b)]).toEqual([2, 1]);
    expect(stored.get(packageKey(a, sha(first)))).toBe(first.length);
    expect(stored.get(packageKey(b, sha(first)))).toBe(first.length);
  });

  it('keeps its files, which only a query that asks for them reads', async () => {
    const a = await account();
    const bytes = zip('exports.handler = async () => 3;');
    await upload(a, bytes);

    const repository = db.dataSource.getRepository(Package);
    expect((await repository.findOneByOrFail({ accountId: a })).files).toBeUndefined();
    expect(
      await repository.findOneOrFail({ where: { accountId: a }, select: { codeSha256: true, files: true, fileCount: true, unpackedSize: true } }),
    ).toEqual({ codeSha256: sha(bytes), files: ['app.js', 'lib/util.js'], fileCount: 2, unpackedSize: 32 + 7 });
  });

  it(`refuses a new package while ${MAX_UNUSED_PACKAGES} are unused, counting only those no zip function of the account names`, async () => {
    const a = await account();
    const b = await account();
    const shas: string[] = [];
    for (let i = 0; i < MAX_UNUSED_PACKAGES; i++) {
      const bytes = zip(`exports.handler = async () => ${i};`);
      await upload(a, bytes);
      shas.push(sha(bytes));
    }

    await expect(upload(a, zip('exports.handler = async () => "one more";'))).rejects.toThrow(
      `The account has ${MAX_UNUSED_PACKAGES} packages that no function names`,
    );
    // Another account's function naming the same bytes doesn't make them used.
    await named(b, shas[0]);
    await expect(upload(a, zip('exports.handler = async () => "one more";'))).rejects.toThrow(`The account has ${MAX_UNUSED_PACKAGES} packages`);
    // Named by a function of its own, a package is used: there is room again.
    await named(a, shas[0]);
    expect((await upload(a, zip('exports.handler = async () => "one more";'))).created).toBe(true);
  });

  it('purges the packages unused for an hour, their zips and their images; keeps one a function names, and one used since', async () => {
    const a = await account();
    const [old, used, recent] = ['old', 'used', 'recent'].map((code) => zip(`exports.handler = async () => "${code}";`));
    for (const bytes of [old, used, recent]) await upload(a, bytes);
    await usedAgo(a, sha(old), 61);
    await usedAgo(a, sha(used), 120);
    await usedAgo(a, sha(recent), 59);
    await named(a, sha(used));
    const image = `sha256:${'a'.repeat(64)}`;
    await query(`UPDATE packages SET image_digest = $3 WHERE account_id = $1 AND code_sha256 = $2`, [a, sha(old), image]);

    await expect(packages.purgeUnused()).resolves.toBe(1);

    expect(await rowsOf(a)).toEqual([sha(used), sha(recent)].sort());
    expect(storage.deleteObject.mock.calls).toEqual([[packageKey(a, sha(old))]]);
    expect(images.deleteImage.mock.calls).toEqual([[a, image]]);
    expect(stored.has(packageKey(a, sha(old)))).toBe(false);
    // A batch at a time, until one comes back short.
    for (const bytes of [old, recent]) {
      await upload(a, bytes);
      await usedAgo(a, sha(bytes), 90);
    }
    await expect(packages.purgeUnused(new Date(), 1)).resolves.toBe(2);
    expect(await rowsOf(a)).toEqual([sha(used)]);
  });

  it('keeps a package an hour from when a function named it, or it was sent again, whatever its age', async () => {
    const a = await account();
    const [named, resent, forgotten] = ['named', 'resent', 'forgotten'].map((code) => zip(`exports.handler = async () => "${code}";`));
    for (const bytes of [named, resent, forgotten]) {
      await upload(a, bytes);
      await usedAgo(a, sha(bytes), 600);
    }

    expect(await packages.name(a, sha(named))).toEqual({ codeSize: named.length, files: ['app.js', 'lib/util.js'] });
    expect((await upload(a, resent)).created).toBe(false);
    expect([await usedAt(a, sha(named)), await usedAt(a, sha(resent)), await usedAt(a, sha(forgotten))]).toEqual([0, 0, 600]);

    await expect(packages.purgeUnused()).resolves.toBe(1);
    expect(await rowsOf(a)).toEqual([sha(named), sha(resent)].sort());
    // Another account's package, or none: nothing to name.
    expect(await packages.name(await account(), sha(named))).toBeUndefined();
  });

  it("keeps inline code's package while a function names it, as no upload: not listed, not counted, and purged an hour after", async () => {
    const a = await account();
    const live = inlinePackage("export const handler = async () => 'live';\n", Runtime.NODEJS);
    const replaced = inlinePackage("export const handler = async () => 'replaced';\n", Runtime.NODEJS);
    for (const built of [live, replaced]) await packages.storeInline(a, built);
    await packages.storeInline(a, live); // a rollout of the same code: kept once
    // The function's record names the package its pods run, as the backend saves it.
    await query(
      `INSERT INTO functions (name, account_id, runtime, code, package_type, code_sha256, code_size, memory, timeout, package_sha256) VALUES ('inline', $1, 'nodejs', $2, 'inline', 'x', 1, 128, 5, $3)`,
      [a, "export const handler = async () => 'live';\n", live.codeSha256],
    );
    for (const built of [live, replaced]) await usedAgo(a, built.codeSha256, 90);

    expect(await rowsOf(a)).toEqual([live.codeSha256, replaced.codeSha256].sort());
    expect(stored.get(packageKey(a, live.codeSha256))).toBe(live.zip.length);
    expect(await packages.list(a)).toEqual([]);
    // Its uploads may still leave 20 unused: the backend's own don't count.
    for (let i = 0; i < MAX_UNUSED_PACKAGES - 1; i++) await upload(a, zip(`exports.handler = async () => ${i};`));
    await expect(upload(a, zip('exports.handler = async () => "one more";'))).resolves.toMatchObject({ created: true });

    await expect(packages.purgeUnused()).resolves.toBe(1);

    expect((await rowsOf(a)).filter((code) => code === live.codeSha256 || code === replaced.codeSha256)).toEqual([live.codeSha256]);
    expect(stored.has(packageKey(a, replaced.codeSha256))).toBe(false);
  });

  it('lists the packages functions name, for the restore of lost images: a zip function\'s and inline code\'s, not an unused or a replaced one', async () => {
    const [a, b] = [await account(), await account()];
    const uploaded = zip('exports.handler = async () => "named";');
    for (const bytes of [uploaded, zip('exports.handler = async () => "unused";')]) await upload(a, bytes);
    await named(a, sha(uploaded));
    const live = inlinePackage("export const handler = async () => 'restored';\n", Runtime.NODEJS);
    const replaced = inlinePackage("export const handler = async () => 'before';\n", Runtime.NODEJS);
    for (const built of [live, replaced]) await packages.storeInline(b, built);
    await query(
      `INSERT INTO functions (name, account_id, runtime, code, package_type, code_sha256, code_size, memory, timeout, package_sha256) VALUES ('inline', $1, 'nodejs', $2, 'inline', 'x', 1, 128, 5, $3)`,
      [b, "export const handler = async () => 'restored';\n", live.codeSha256],
    );

    expect((await packages.named()).filter((found) => [a, b].includes(found.accountId))).toEqual([
      { accountId: a, codeSha256: sha(uploaded), inline: false },
      { accountId: b, codeSha256: live.codeSha256, inline: true },
    ]);

    // Its zip lost with object storage, then stored again, made of the function's code.
    stored.delete(packageKey(b, live.codeSha256));
    await packages.restoreInlineZip(b, live);
    expect(stored.get(packageKey(b, live.codeSha256))).toBe(live.zip.length);
  });

  it("keeps the package a version names once its function's code has moved on, until the version goes", async () => {
    const a = await account();
    const [kept, current] = [zip('exports.handler = async () => "v1";'), zip('exports.handler = async () => "v2";')];
    for (const bytes of [kept, current]) await upload(a, bytes);
    await named(a, sha(current));
    const [{ id }] = await query<Array<{ id: string }>>(`SELECT id FROM functions WHERE account_id = $1`, [a]);
    await query(
      `INSERT INTO function_versions (function_id, version, account_id, runtime, handler, package_type, code, code_sha256, code_size, package_sha256, memory, timeout, event_format, aws_endpoints)
       VALUES ($1, 1, $2, 'nodejs', 'app.handler', 'zip', '', $3, 100, $3, 128, 5, 'lambda', '{s3}')`,
      [id, a, sha(kept)],
    );
    for (const bytes of [kept, current]) await usedAgo(a, sha(bytes), 90);

    await expect(packages.purgeUnused()).resolves.toBe(0);
    const namedOfA = (await packages.named()).filter((found) => found.accountId === a).map((found) => found.codeSha256);
    expect(namedOfA.sort()).toEqual([sha(current), sha(kept)].sort());

    await query(`DELETE FROM function_versions WHERE function_id = $1`, [id]);
    await expect(packages.purgeUnused()).resolves.toBe(1);
    expect(await rowsOf(a)).toEqual([sha(current)]);
  });

  it("deletes all of an account's packages and their zips, and no other account's", async () => {
    const closed = await account();
    const other = await account();
    const bytes = zip('exports.handler = async () => "closing";');
    await upload(closed, bytes);
    await upload(other, bytes);

    const image = `sha256:${'b'.repeat(64)}`;
    await query(`UPDATE packages SET image_digest = $2 WHERE account_id = $1`, [closed, image]);

    await expect(packages.deleteAll(closed)).resolves.toBe(1);

    expect([await rowsOf(closed), await rowsOf(other)]).toEqual([[], [sha(bytes)]]);
    expect(storage.deleteObject.mock.calls).toEqual([[packageKey(closed, sha(bytes))]]);
    expect(images.deleteImage.mock.calls).toEqual([[closed, image]]);
  });
});

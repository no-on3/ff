import { BadRequestException, Injectable, Logger, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import type { InlinePackage } from '../functions/inline-package';
import { ObjectStoreService } from '../object-store/object-store.service';
import { CodeImagesService } from './code-images.service';
import { PACKAGE_LIMITS, PackageRefused, readPackage } from './package-archive';
import { Package, packageKey } from './package.entity';

/** The media types a zip comes as: its own, the one older Windows tools send, or plain bytes. */
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
/**
 * How many packages an account keeps that no function names, at most, and how
 * long one is kept unnamed after its upload or its last use: a package is
 * uploaded to be named at once, by the create or update that follows, and the
 * storage uploads take stays bounded.
 */
export const MAX_UNUSED_PACKAGES = 20;
export const UNUSED_PACKAGE_HOURS = 1;
const UNIQUE_VIOLATION = '23505';

/** A package as the API answers it: what it is, without its files, which can be thousands. */
export type PackageView = Pick<Package, 'codeSha256' | 'codeSize' | 'unpackedSize' | 'fileCount' | 'createdAt'>;

const viewOf = ({ codeSha256, codeSize, unpackedSize, fileCount, createdAt }: Package): PackageView => ({ codeSha256, codeSize, unpackedSize, fileCount, createdAt });

/**
 * Whether a function or a version of its account names the package "p", its
 * pods running it: a package function's own, and the one-file package of
 * inline code (package_sha256); or a package function's code_sha256, as a
 * backend from before packages named inline code saved it. The others are
 * unused. `otherThan`, a query's parameter, leaves one function's record out.
 */
const namedBy = (otherThan?: string): string =>
  `(EXISTS (SELECT 1 FROM "functions" "f" WHERE "f"."account_id" = "p"."account_id"${otherThan ? ` AND "f"."id" <> ${otherThan}` : ''}` +
  ` AND ("f"."package_sha256" = "p"."code_sha256" OR ("f"."package_type" = 'zip' AND "f"."code_sha256" = "p"."code_sha256")))` +
  ` OR EXISTS (SELECT 1 FROM "function_versions" "v" WHERE "v"."account_id" = "p"."account_id" AND "v"."package_sha256" = "p"."code_sha256"))`;
const NAMED = namedBy();

const bytes = (n: number): string => n.toLocaleString('en-US');
const hours = (n: number): string => (n === 1 ? 'an hour' : `${n} hours`);

/** Past Lambda's 50 MB for a package uploaded directly. */
const tooLarge = () =>
  new PayloadTooLargeException(`A package may have ${bytes(PACKAGE_LIMITS.zipBytes)} bytes (50 MB) at most, as AWS Lambda takes one uploaded directly`);

/** Writes the body to `file` as it comes, hashing it, and refuses it past the limit. Answers its SHA-256 in base64 and its size. */
async function receive(body: Readable, file: string): Promise<{ codeSha256: string; codeSize: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > PACKAGE_LIMITS.zipBytes) return done(tooLarge());
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, counted, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (error instanceof PayloadTooLargeException) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE') throw new BadRequestException('The upload stopped before the end of the package');
    throw error;
  }
  return { codeSha256: hash.digest('base64'), codeSize: size };
}

/**
 * Functions' packages: a zip, as AWS Lambda takes one, uploaded once, checked
 * (package-archive.ts), kept in object storage and named by its SHA-256, which
 * a function gives in place of inline code; or the one-file package the
 * backend makes of inline code (inline-package.ts). Its code runs as an image
 * (CodeImagesService). An account has each package once.
 * A package that no function names is deleted, with its image, by the
 * retention job an hour after its upload or its last use; a closed account's
 * go with its data.
 */
@Injectable()
export class PackagesService {
  private readonly logger = new Logger(PackagesService.name);

  constructor(
    @InjectRepository(Package) private readonly packages: Repository<Package>,
    private readonly storage: ObjectStoreService,
    private readonly audit: AuditService,
    private readonly images: CodeImagesService,
  ) {}

  /**
   * Takes a package from a request's body: written to a temporary file as it
   * comes, within 50 MB; then, unless the account has it already, checked,
   * stored, and recorded, with an entry in the audit log. Answers it, and
   * whether it is new.
   */
  async upload(accountId: string, body: Readable, contentType: string | undefined, contentLength?: number): Promise<{ created: boolean; package: PackageView }> {
    const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (!ZIP_TYPES.has(type)) {
      throw new UnsupportedMediaTypeException(`Send the package as the body, a zip archive, with Content-Type: application/zip${type ? `, not ${type}` : ''}`);
    }
    if (contentLength !== undefined && contentLength > PACKAGE_LIMITS.zipBytes) throw tooLarge();
    const file = join(tmpdir(), `ff-package-${randomUUID()}.zip`);
    try {
      const { codeSha256, codeSize } = await receive(body, file);
      if (codeSize === 0) throw new BadRequestException('The body is empty: send the package, a zip archive');
      const existing = await this.find(accountId, codeSha256);
      if (existing) {
        // Sent again to be named: kept another hour; and an upload, if the backend had made the same of inline code.
        await this.packages.update({ accountId, codeSha256 }, { usedAt: () => 'now()', inline: false });
        return { created: false, package: existing };
      }
      await this.refuseTooManyUnused(accountId);
      const contents = await readPackage(file).catch((error: unknown) => {
        throw error instanceof PackageRefused ? new BadRequestException(error.message) : error;
      });
      // The bytes first: a row never names a package that object storage hasn't.
      await this.storage.putFile(packageKey(accountId, codeSha256), file, codeSize, 'application/zip');
      const record = { accountId, codeSha256, codeSize, unpackedSize: contents.unpackedSize, fileCount: contents.files.length };
      try {
        await this.packages.manager.transaction(async (manager) => {
          await manager.insert(Package, { ...record, files: contents.files });
          await this.audit.record(
            { accountId, action: 'package.upload', resource: `package:${codeSha256}`, details: { codeSha256, codeSize, unpackedSize: record.unpackedSize, files: record.fileCount } },
            manager,
          );
        });
      } catch (error) {
        // The same package, uploaded by another request meanwhile: the account has it once.
        if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) {
          const kept = await this.find(accountId, codeSha256);
          if (kept) return { created: false, package: kept };
        }
        throw error;
      }
      return { created: true, package: (await this.find(accountId, codeSha256)) as PackageView };
    } finally {
      await rm(file, { force: true });
    }
  }

  /** The account's package of this SHA-256, if it has one. */
  async find(accountId: string, codeSha256: string): Promise<PackageView | undefined> {
    const found = await this.packages.findOneBy({ accountId, codeSha256 });
    return found ? viewOf(found) : undefined;
  }

  /**
   * The package a function names, with its files, which its handler is looked
   * for in; none when the account hasn't it. Its last use is now: the retention
   * job keeps it for the rollout under way, and an hour more.
   */
  async name(accountId: string, codeSha256: string): Promise<{ codeSize: number; files: string[] } | undefined> {
    const [rows] = await this.packages.query<[Array<{ code_size: number; files: string[] }>, number]>(
      `UPDATE "packages" SET "used_at" = now() WHERE "account_id" = $1 AND "code_sha256" = $2 RETURNING "code_size", "files"`,
      [accountId, codeSha256],
    );
    return rows[0] ? { codeSize: rows[0].code_size, files: rows[0].files } : undefined;
  }

  /** The account's packages, newest first; with a SHA-256, the one of it, if any. Those the backend made of inline code aren't the account's uploads: left out. */
  async list(accountId: string, codeSha256?: string): Promise<PackageView[]> {
    const where = codeSha256 === undefined ? { accountId, inline: false } : { accountId, codeSha256, inline: false };
    const found = await this.packages.find({ where, order: { createdAt: 'DESC' } });
    return found.map(viewOf);
  }

  /**
   * Keeps the one-file package the backend made of a function's inline code
   * (inline-package.ts), once, its last use now, as naming an uploaded one
   * makes it: the purge keeps it while a function's record names it, and an
   * hour after. No checks and no audit entry, as the backend made it of code
   * the API took; and none of the uploads' limits, as the account uploaded
   * nothing.
   */
  async storeInline(accountId: string, built: InlinePackage): Promise<void> {
    const [touched] = await this.packages.query<[Array<{ id: string }>, number]>(
      `UPDATE "packages" SET "used_at" = now() WHERE "account_id" = $1 AND "code_sha256" = $2 RETURNING "id"`,
      [accountId, built.codeSha256],
    );
    if (touched.length) return;
    // The bytes first, as for an upload: a row never names a package that object storage hasn't.
    await this.storage.putDocument(packageKey(accountId, built.codeSha256), built.zip, 'application/zip');
    await this.packages
      .createQueryBuilder()
      .insert()
      .values({ accountId, codeSha256: built.codeSha256, codeSize: built.zip.length, unpackedSize: built.unpackedSize, fileCount: 1, files: [built.file], inline: true })
      // Made by another rollout meanwhile: the account has it once.
      .orIgnore()
      .execute();
  }

  /**
   * Stores again the zip of a one-file package that object storage has lost,
   * made again of its function's code: the same code makes the same zip, which
   * the caller has checked by its SHA-256.
   */
  async restoreInlineZip(accountId: string, built: InlinePackage): Promise<void> {
    await this.storage.putDocument(packageKey(accountId, built.codeSha256), built.zip, 'application/zip');
  }

  /** The packages that functions and versions name, their pods running their images: each one's account and SHA-256, and whether the backend made it of inline code. */
  async named(): Promise<Array<{ accountId: string; codeSha256: string; inline: boolean }>> {
    const rows = await this.packages.query<Array<{ account_id: string; code_sha256: string; inline: boolean }>>(
      `SELECT "p"."account_id", "p"."code_sha256", "p"."inline" FROM "packages" "p" WHERE ${NAMED} ORDER BY "p"."account_id", "p"."code_sha256"`,
    );
    return rows.map((row) => ({ accountId: row.account_id, codeSha256: row.code_sha256, inline: row.inline }));
  }

  /**
   * The bytes of the packages the account's functions and versions name, as
   * the plan's code storage counts them, each package once; `besides` left
   * out, a package a change is about to name, and the one `otherThan`'s record
   * names, which the change replaces, unless another names it too.
   */
  async namedBytes(accountId: string, besides: string, otherThan?: string): Promise<number> {
    const [{ bytes }] = await this.packages.query<Array<{ bytes: string }>>(
      `SELECT COALESCE(sum("p"."code_size"), 0)::bigint AS "bytes" FROM "packages" "p" WHERE "p"."account_id" = $1 AND "p"."code_sha256" <> $2 AND ${namedBy(otherThan ? '$3' : undefined)}`,
      otherThan ? [accountId, besides, otherThan] : [accountId, besides],
    );
    return Number(bytes);
  }

  /** 400 when the account keeps as many uploaded packages as it may that no function names: one must go, or be named. */
  private async refuseTooManyUnused(accountId: string): Promise<void> {
    const [{ unused }] = await this.packages.query<Array<{ unused: number }>>(
      `SELECT count(*)::int AS "unused" FROM "packages" "p" WHERE "p"."account_id" = $1 AND NOT "p"."inline" AND NOT ${NAMED}`,
      [accountId],
    );
    if (unused >= MAX_UNUSED_PACKAGES) {
      throw new BadRequestException(
        `The account has ${unused} packages that no function names, ${MAX_UNUSED_PACKAGES} at most: name one in a function, ` +
          `or upload this one once those are deleted, within ${hours(UNUSED_PACKAGE_HOURS)} of their upload`,
      );
    }
  }

  /**
   * Deletes the packages that no function names, unused for an hour before
   * `now`, a batch at a time: the rows first, each checked again as it goes, so
   * that a package a function has just named stays; then their zips and their
   * images. One that can't be deleted is logged: no row names it any more.
   * Returns how many packages were deleted.
   */
  async purgeUnused(now = new Date(), batch = 100): Promise<number> {
    const before = new Date(now.getTime() - UNUSED_PACKAGE_HOURS * 3_600_000);
    let deleted = 0;
    for (;;) {
      const gone = await this.packages.manager.transaction(async (manager) => {
        const candidates: Array<{ id: string }> = await manager.query(
          `SELECT "p"."id" FROM "packages" "p" WHERE "p"."used_at" < $1 AND NOT ${NAMED} ORDER BY "p"."used_at" LIMIT $2 FOR UPDATE OF "p" SKIP LOCKED`,
          [before, batch],
        );
        if (candidates.length === 0) return { rows: [] as Array<{ account_id: string; code_sha256: string; image_digest: string | null }>, full: false };
        // A statement of its own sees the functions saved since the one above, and a use since: a package named meanwhile stays.
        const [rows] = await manager.query<[Array<{ account_id: string; code_sha256: string; image_digest: string | null }>, number]>(
          `DELETE FROM "packages" "p" WHERE "p"."id" = ANY($1) AND "p"."used_at" < $2 AND NOT ${NAMED} RETURNING "p"."account_id", "p"."code_sha256", "p"."image_digest"`,
          [candidates.map((candidate) => candidate.id), before],
        );
        return { rows, full: candidates.length === batch };
      });
      for (const row of gone.rows) {
        await this.storage
          .deleteObject(packageKey(row.account_id, row.code_sha256))
          .catch((error: unknown) => this.logger.error(`Could not delete the zip of package ${row.code_sha256} of account ${row.account_id}: ${describeError(error)}`));
        if (row.image_digest) {
          await this.images
            .deleteImage(row.account_id, row.image_digest)
            .catch((error: unknown) => this.logger.error(`Could not delete the image of package ${row.code_sha256} of account ${row.account_id}: ${describeError(error)}`));
        }
      }
      deleted += gone.rows.length;
      if (!gone.full) break;
    }
    if (deleted) this.logger.log(`Deleted ${deleted} package(s) that no function named within ${hours(UNUSED_PACKAGE_HOURS)} of their upload`);
    return deleted;
  }

  /**
   * Deletes all of a closed account's packages: each zip and each image first,
   * so that a run that fails part way leaves rows for the next to find; then
   * the rows. Returns how many there were.
   */
  async deleteAll(accountId: string): Promise<number> {
    const rows = await this.packages.find({ where: { accountId }, select: { id: true, codeSha256: true, imageDigest: true } });
    for (const row of rows) {
      await this.storage.deleteObject(packageKey(accountId, row.codeSha256));
      if (row.imageDigest) await this.images.deleteImage(accountId, row.imageDigest);
    }
    await this.packages.delete({ accountId });
    return rows.length;
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { PlansService } from '../plans/plans.service';
import { Bucket, BucketStatus } from './bucket.entity';
import { BucketView, CreateBucketDto } from './dto/storage.dto';
import { StorageKey } from './storage-key.entity';
import { newStoreName } from './storage-names';
import { StoreBuckets } from './store-buckets';

/** A bucket as FF's operators see it: its name in the store too, and its last hourly measure, null before the first. */
export interface MeasuredBucket {
  name: string;
  storeName: string;
  status: BucketStatus;
  sizeBytes: number | null;
  objects: number | null;
  /** The hour of its last measure. */
  measuredAt: Date | null;
  createdAt: Date;
}

/** PostgreSQL's unique_violation: a bucket of that name exists, whoever's it is. */
const UNIQUE_VIOLATION = '23505';

const unavailable = () => new ServiceUnavailableException("The store couldn't do it: nothing was lost, try again in a moment");

/**
 * Customers' buckets (ADR 0009): made with FF's API, as the plan allows, their
 * names unique across FF as on AWS, each a bucket of the store under a name of
 * FF's; deleted empty, or emptied first when asked; each change in the audit
 * log. A closed account's go with its data, at its data deletion date.
 */
@Injectable()
export class BucketsService {
  private readonly logger = new Logger(BucketsService.name);
  private readonly endpoint: URL;
  private readonly region: string;

  constructor(
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
    private readonly store: StoreBuckets,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.endpoint = new URL(config.getOrThrow<string>('storage.base'));
    this.region = config.getOrThrow<string>('storage.region');
  }

  /** The account's buckets, by name, each with what it held at its last hourly measure. */
  async list(accountId: string): Promise<BucketView[]> {
    return (await this.measured(accountId)).map((row) => this.view(row));
  }

  async get(accountId: string, name: string): Promise<BucketView> {
    const [row] = await this.measured(accountId, name);
    if (!row) throw new NotFoundException(`The account has no bucket named "${name}"`);
    return this.view(row);
  }

  /** The account's buckets, or the one named, as FF's operators see them too: their names in the store, and what each held at its last hourly measure. */
  async measured(accountId: string, name?: string): Promise<MeasuredBucket[]> {
    const rows = await this.buckets.manager.query<
      Array<{ name: string; store_name: string; status: BucketStatus; created_at: Date; size_bytes: string | null; objects: string | null; hour: Date | null }>
    >(
      `SELECT b."name", b."store_name", b."status", b."created_at", s."size_bytes"::text, s."objects"::text, s."hour"
         FROM "buckets" b
         LEFT JOIN LATERAL (SELECT "size_bytes", "objects", "hour" FROM "bucket_samples" WHERE "bucket_id" = b."id" ORDER BY "hour" DESC LIMIT 1) s ON true
        WHERE b."account_id" = $1 AND ($2::text IS NULL OR b."name" = $2)
        ORDER BY b."name"`,
      [accountId, name ?? null],
    );
    return rows.map((row) => ({
      name: row.name,
      storeName: row.store_name,
      status: row.status,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      objects: row.objects === null ? null : Number(row.objects),
      measuredAt: row.hour,
      createdAt: row.created_at,
    }));
  }

  /**
   * A new bucket, within the plan: counted under a lock on the account, so
   * that two at once can't pass it together; then made in the store, and its
   * row taken back if the store can't.
   */
  async create(accountId: string, dto: CreateBucketDto): Promise<BucketView> {
    const account = await this.buckets.manager.findOneBy(Account, { id: accountId });
    if (account?.storageDisabledAt) throw new ForbiddenException(`FF turned this account's databases and buckets off: ${account.storageDisabledReason}`);
    const plan = await this.plans.forAccount(accountId);
    let row: Bucket;
    try {
      row = await this.buckets.manager.transaction(async (manager) => {
        await manager.findOne(Account, { where: { id: accountId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
        const count = await manager.countBy(Bucket, { accountId });
        if (count >= plan.limits.buckets) {
          throw new BadRequestException(`The ${plan.name} plan allows ${plan.limits.buckets} bucket${plan.limits.buckets === 1 ? '' : 's'}, and the account has ${count}: delete one first`);
        }
        return manager.save(Bucket, manager.create(Bucket, { accountId, name: dto.name, storeName: newStoreName() }));
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) {
        throw new ConflictException(`The bucket name "${dto.name}" is taken: bucket names are unique across FF, as on AWS`);
      }
      throw error;
    }
    try {
      await this.store.create(row.storeName);
    } catch (error) {
      await this.buckets.delete({ id: row.id });
      this.logger.error(`Could not make bucket ${row.storeName} of account ${accountId} in the store: ${describeError(error)}`);
      throw unavailable();
    }
    await this.audit.record({ accountId, action: 'bucket.create', resource: `bucket:${row.name}`, details: { name: row.name, store: row.storeName } });
    return this.view(row);
  }

  /**
   * The bucket, gone: empty, as S3 deletes one; with `force`, every object
   * deleted first, and every upload under way aborted. It answers no S3
   * request from the start; a failure part way leaves it deleting, and asking
   * again finishes.
   */
  async remove(accountId: string, name: string, force: boolean): Promise<void> {
    const row = await this.bucketOf(accountId, name);
    if (!force && !(await this.storeCall(() => this.store.isEmpty(row.storeName)))) {
      throw new ConflictException(`The bucket ${name} isn't empty: delete its objects first, or delete it with ?force=true, which deletes them all`);
    }
    await this.buckets.update({ id: row.id }, { status: BucketStatus.DELETING });
    const objects = force ? await this.storeCall(() => this.store.empty(row.storeName)) : 0;
    await this.storeCall(() => this.store.delete(row.storeName));
    await this.buckets.delete({ id: row.id });
    await this.audit.record({ accountId, action: 'bucket.delete', resource: `bucket:${row.name}`, details: { name: row.name, store: row.storeName, objects } });
  }

  /** A closed account's buckets, emptied and deleted, and its keys revoked, at its data deletion date; answers how many buckets went. */
  async deleteAll(accountId: string): Promise<number> {
    const rows = await this.buckets.find({ where: { accountId } });
    for (const row of rows) {
      await this.buckets.update({ id: row.id }, { status: BucketStatus.DELETING });
      await this.store.empty(row.storeName);
      await this.store.delete(row.storeName);
      await this.buckets.delete({ id: row.id });
    }
    await this.buckets.manager.update(StorageKey, { accountId, revokedAt: IsNull() }, { revokedAt: new Date() });
    return rows.length;
  }

  private async bucketOf(accountId: string, name: string): Promise<Bucket> {
    const row = await this.buckets.findOneBy({ accountId, name });
    if (!row) throw new NotFoundException(`The account has no bucket named "${name}"`);
    return row;
  }

  private async storeCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.logger.error(`The store failed on a bucket's change: ${describeError(error)}`);
      throw unavailable();
    }
  }

  /** A bucket as the API answers it; a new one has no measure yet. */
  private view(row: Pick<Bucket, 'name' | 'status' | 'createdAt'> & Partial<Pick<MeasuredBucket, 'sizeBytes' | 'objects' | 'measuredAt'>>): BucketView {
    const url = new URL(this.endpoint);
    url.hostname = `${row.name}.${this.endpoint.hostname}`;
    return {
      name: row.name,
      status: row.status,
      region: this.region,
      endpoint: this.endpoint.origin,
      url: url.origin,
      sizeBytes: row.sizeBytes ?? null,
      objects: row.objects ?? null,
      measuredAt: row.measuredAt ?? null,
      createdAt: row.createdAt,
    };
  }
}

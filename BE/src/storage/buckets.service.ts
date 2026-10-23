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

  /** The account's buckets, by name. */
  async list(accountId: string): Promise<BucketView[]> {
    return (await this.buckets.find({ where: { accountId }, order: { name: 'ASC' } })).map((row) => this.view(row));
  }

  async get(accountId: string, name: string): Promise<BucketView> {
    return this.view(await this.bucketOf(accountId, name));
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

  private view(row: Bucket): BucketView {
    const url = new URL(this.endpoint);
    url.hostname = `${row.name}.${this.endpoint.hostname}`;
    return {
      name: row.name,
      status: row.status,
      region: this.region,
      endpoint: this.endpoint.origin,
      url: url.origin,
      createdAt: row.createdAt,
    };
  }
}

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { PlansService } from '../plans/plans.service';
import { CreateStorageKeyDto, CreatedDeployKey, CreatedStorageKey, StorageKeyView } from './dto/storage.dto';
import { Bucket, BucketStatus } from './bucket.entity';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from './storage-names';

/** How long a deploy's key works: an hour, as an STS session lasts by default. */
export const DEPLOY_KEY_MS = 60 * 60_000;

/** The account's own keys, which work until revoked: neither a function's nor a deploy's. */
const ACCOUNT_KEYS = { functionId: IsNull(), expiresAt: IsNull(), revokedAt: IsNull() };

/**
 * The account's own access keys to its buckets (ADR 0009), queues (ADR 0010),
 * mail (ADR 0012) and functions (ADR 0014): an ID like AWS's, a name, and a
 * secret shown once, which FF keeps sealed since the front doors need it to
 * check signatures. As many as the plan's accessKeys, counted under a lock on
 * the account, each name once among them. A key stays as it was made: another
 * reach is another key. A revoked key keeps its row, so that its ID is never
 * another's. Functions' own keys are their functions'. A deploy's key, which
 * `ff sites deploy` signs its uploads with, reaches one bucket for an hour:
 * any member who may write the bucket gets one, as many as deploys, never
 * listed or counted with the account's own.
 */
@Injectable()
export class StorageKeysService {
  private readonly endpoint: string;
  private readonly sqsEndpoint: string;
  private readonly sesEndpoint: string;
  private readonly region: string;

  constructor(
    @InjectRepository(StorageKey) private readonly keys: Repository<StorageKey>,
    private readonly directory: StorageDirectory,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    config: ConfigService,
  ) {
    this.endpoint = new URL(config.getOrThrow<string>('storage.base')).origin;
    this.sqsEndpoint = config.get<string>('sqs.base') ?? '';
    this.sesEndpoint = config.get<string>('ses.base') ?? '';
    this.region = config.getOrThrow<string>('storage.region');
  }

  /** The account's own keys that work, oldest first: never a secret. */
  async list(accountId: string): Promise<StorageKeyView[]> {
    const rows = await this.keys.find({ where: { accountId, ...ACCOUNT_KEYS }, order: { createdAt: 'ASC' } });
    return rows.map((row) => this.view(row));
  }

  /** A new key, named its ID when the request names none, its secret in this answer only. */
  async create(accountId: string, dto: CreateStorageKeyDto): Promise<CreatedStorageKey> {
    const plan = await this.plans.forAccount(accountId);
    const id = newAccessKeyId();
    const name = dto.name ?? id;
    const secretAccessKey = newSecretAccessKey();
    const row = await this.keys.manager.transaction(async (manager) => {
      await manager.findOne(Account, { where: { id: accountId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
      const count = await manager.countBy(StorageKey, { accountId, ...ACCOUNT_KEYS });
      const most = plan.limits.accessKeys;
      if (count >= most) throw new BadRequestException(`The ${plan.name} plan allows ${most} access key${most === 1 ? '' : 's'}, and the account has ${count}: revoke one first`);
      if (await manager.existsBy(StorageKey, { accountId, name, revokedAt: IsNull() })) throw new ConflictException(`The account has an access key named "${name}" already`);
      return manager.save(
        StorageKey,
        manager.create(StorageKey, {
          id,
          accountId,
          name,
          secret: this.directory.sealSecret(id, secretAccessKey),
          buckets: dto.buckets ?? null,
          queues: dto.queues ?? null,
          functions: dto.functions ?? null,
          functionAccess: dto.functionAccess ?? null,
          readOnly: dto.readOnly ?? false,
        }),
      );
    });
    const { buckets, queues, functions, functionAccess, readOnly } = row;
    await this.audit.record({ accountId, action: 'storage_key.create', resource: `storage_key:${id}`, details: { name, buckets, queues, functions, functionAccess, readOnly } });
    return { ...this.view(row), secretAccessKey, endpoint: this.endpoint, sqsEndpoint: this.sqsEndpoint, sesEndpoint: this.sesEndpoint, region: this.region };
  }

  /** The key stops working at once: the front door refuses its next request. */
  async revoke(accountId: string, id: string): Promise<void> {
    const revoked = await this.keys.update({ id, accountId, ...ACCOUNT_KEYS }, { revokedAt: new Date() });
    if (!revoked.affected) throw new NotFoundException(`The account has no access key ${id}`);
    await this.audit.record({ accountId, action: 'storage_key.delete', resource: `storage_key:${id}` });
  }

  /** POST /buckets/:name/website/deploy-keys: a key to the bucket alone, read-write, for an hour; its secret in this answer only. */
  async createDeployKey(accountId: string, bucket: string, now = new Date()): Promise<CreatedDeployKey> {
    await this.bucketOf(accountId, bucket);
    const id = newAccessKeyId();
    const secretAccessKey = newSecretAccessKey();
    const expiresAt = new Date(now.getTime() + DEPLOY_KEY_MS);
    await this.keys.insert({ id, accountId, secret: this.directory.sealSecret(id, secretAccessKey), buckets: [bucket], queues: null, readOnly: false, expiresAt });
    await this.audit.record({ accountId, action: 'bucket.deploy_key', resource: `bucket:${bucket}`, details: { accessKeyId: id, expiresAt: expiresAt.toISOString() } });
    return { bucket, accessKeyId: id, secretAccessKey, expiresAt, endpoint: this.endpoint, region: this.region };
  }

  /** A deploy's key to the bucket stops working at once, as its deploy ends; its hour is up anyway soon. */
  async revokeDeployKey(accountId: string, bucket: string, id: string): Promise<void> {
    await this.bucketOf(accountId, bucket);
    const key = await this.keys.findOneBy({ id, accountId, functionId: IsNull(), revokedAt: IsNull() });
    if (!key?.expiresAt || !key.buckets?.includes(bucket)) throw new NotFoundException(`The bucket ${bucket} has no deploy key ${id}`);
    await this.keys.update({ id }, { revokedAt: new Date() });
  }

  private async bucketOf(accountId: string, name: string): Promise<void> {
    const found = await this.keys.manager.existsBy(Bucket, { accountId, name, status: BucketStatus.ACTIVE });
    if (!found) throw new NotFoundException(`The account has no bucket named "${name}"`);
  }

  private view(row: StorageKey): StorageKeyView {
    const { id, buckets, queues, readOnly, functions, functionAccess, createdAt, lastUsedAt } = row;
    return { id, name: row.name ?? id, buckets, queues, readOnly, functions, functionAccess, createdAt, lastUsedAt };
  }
}

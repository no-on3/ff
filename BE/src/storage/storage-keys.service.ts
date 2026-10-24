import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Account } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { CreateStorageKeyDto, CreatedStorageKey, StorageKeyView } from './dto/storage.dto';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from './storage-names';

/** An account's own keys at most, as IAM gives a user two, so that one can replace the other. */
export const MAX_ACCOUNT_KEYS = 2;

/**
 * The account's own access keys to its buckets (ADR 0009) and queues (ADR
 * 0010): an ID like AWS's, and a secret shown once, which FF keeps sealed since
 * the S3 front door and the SQS endpoint need it to check signatures. Two at
 * most, counted under a lock on the account. A revoked key keeps its row, so
 * that its ID is never another's. Functions' own keys are their functions'.
 */
@Injectable()
export class StorageKeysService {
  private readonly endpoint: string;
  private readonly sqsEndpoint: string;
  private readonly region: string;

  constructor(
    @InjectRepository(StorageKey) private readonly keys: Repository<StorageKey>,
    private readonly directory: StorageDirectory,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.endpoint = new URL(config.getOrThrow<string>('storage.base')).origin;
    this.sqsEndpoint = config.get<string>('sqs.base') ?? '';
    this.region = config.getOrThrow<string>('storage.region');
  }

  /** The account's own keys that work, oldest first: never a secret. */
  async list(accountId: string): Promise<StorageKeyView[]> {
    const rows = await this.keys.find({ where: { accountId, functionId: IsNull(), revokedAt: IsNull() }, order: { createdAt: 'ASC' } });
    return rows.map((row) => this.view(row));
  }

  /** A new key, its secret in this answer only. */
  async create(accountId: string, dto: CreateStorageKeyDto): Promise<CreatedStorageKey> {
    const id = newAccessKeyId();
    const secretAccessKey = newSecretAccessKey();
    const row = await this.keys.manager.transaction(async (manager) => {
      await manager.findOne(Account, { where: { id: accountId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
      const count = await manager.countBy(StorageKey, { accountId, functionId: IsNull(), revokedAt: IsNull() });
      if (count >= MAX_ACCOUNT_KEYS) {
        throw new ConflictException(`The account has ${MAX_ACCOUNT_KEYS} access keys, the most it may have, as IAM gives a user: revoke one first`);
      }
      return manager.save(
        StorageKey,
        manager.create(StorageKey, {
          id,
          accountId,
          secret: this.directory.sealSecret(id, secretAccessKey),
          buckets: dto.buckets ?? null,
          queues: dto.queues ?? null,
          readOnly: dto.readOnly ?? false,
        }),
      );
    });
    await this.audit.record({ accountId, action: 'storage_key.create', resource: `storage_key:${id}`, details: { buckets: row.buckets, queues: row.queues, readOnly: row.readOnly } });
    return { ...this.view(row), secretAccessKey, endpoint: this.endpoint, sqsEndpoint: this.sqsEndpoint, region: this.region };
  }

  /** The key stops working at once: the front door refuses its next request. */
  async revoke(accountId: string, id: string): Promise<void> {
    const revoked = await this.keys.update({ id, accountId, functionId: IsNull(), revokedAt: IsNull() }, { revokedAt: new Date() });
    if (!revoked.affected) throw new NotFoundException(`The account has no access key ${id}`);
    await this.audit.record({ accountId, action: 'storage_key.delete', resource: `storage_key:${id}` });
  }

  private view(row: StorageKey): StorageKeyView {
    return { id: row.id, buckets: row.buckets, queues: row.queues, readOnly: row.readOnly, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
  }
}

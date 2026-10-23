import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { describeError } from '../common/describe-error';
import { Account } from '../accounts/entities/account.entity';
import { Sealed } from '../encryption/envelope';
import { EncryptionService } from '../encryption/encryption.service';
import { Bucket, BucketStatus } from './bucket.entity';
import { StorageKey } from './storage-key.entity';

/** What an access key's secret is sealed for: that key alone. */
export const sealedFor = (accessKeyId: string): string => `storage-key/${accessKeyId}`;

/** A key the front door checks a signature with: its account, what it reaches, and its secret, opened. */
export interface ActiveKey {
  id: string;
  accountId: string;
  functionId: string | null;
  /** The buckets it reaches by name; null for all the account's. */
  buckets: string[] | null;
  readOnly: boolean;
  secret: string;
}

/** How often a key's last use is written down: at most once a minute. */
const TOUCH_INTERVAL_MS = 60_000;

/** Keys and buckets as the front door looks them up, by access key ID and by bucket name. */
@Injectable()
export class StorageDirectory {
  private readonly logger = new Logger(StorageDirectory.name);
  private readonly touched = new Map<string, number>();

  constructor(
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
    @InjectRepository(StorageKey) private readonly keys: Repository<StorageKey>,
    private readonly encryption: EncryptionService,
  ) {}

  /** A secret, sealed for its key, as a key's row keeps it. */
  sealSecret(accessKeyId: string, secret: string): Sealed {
    return this.encryption.sealJson(secret, sealedFor(accessKeyId));
  }

  /** The key of that ID, unless it is revoked; null for any other. */
  async key(accessKeyId: string): Promise<ActiveKey | null> {
    const key = await this.keys.findOneBy({ id: accessKeyId, revokedAt: IsNull() });
    if (!key) return null;
    return {
      id: key.id,
      accountId: key.accountId,
      functionId: key.functionId,
      buckets: key.buckets,
      readOnly: key.readOnly,
      secret: this.encryption.openJson<string>(key.secret, sealedFor(key.id)),
    };
  }

  /** The account a key belongs to: its status, and whether FF turned its storage off; null for none. */
  account(accountId: string): Promise<Pick<Account, 'id' | 'status' | 'planId' | 'storageDisabledAt' | 'storageDisabledReason'> | null> {
    return this.buckets.manager.findOne(Account, { where: { id: accountId }, select: { id: true, status: true, planId: true, storageDisabledAt: true, storageDisabledReason: true } });
  }

  /** The active bucket of that name, whoever's it is. */
  bucket(name: string): Promise<Bucket | null> {
    return this.buckets.findOneBy({ name, status: BucketStatus.ACTIVE });
  }

  /** An account's active buckets, by name. */
  bucketsOf(accountId: string): Promise<Bucket[]> {
    return this.buckets.find({ where: { accountId, status: BucketStatus.ACTIVE }, order: { name: 'ASC' } });
  }

  /** Writes down that a key was used now, once a minute at most; never waits, and a failure only logs. */
  touch(accessKeyId: string, now = new Date()): void {
    const last = this.touched.get(accessKeyId);
    if (last !== undefined && now.getTime() - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(accessKeyId, now.getTime());
    const minute = new Date(Math.floor(now.getTime() / TOUCH_INTERVAL_MS) * TOUCH_INTERVAL_MS);
    this.keys.update({ id: accessKeyId }, { lastUsedAt: minute }).catch((error: unknown) => {
      this.logger.warn(`Could not write down access key ${accessKeyId}'s last use: ${describeError(error)}`);
    });
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from './storage-names';

/** PostgreSQL's unique_violation: another deploy of the function made its key meanwhile. */
const UNIQUE_VIOLATION = '23505';

/** What a function's pods get to reach its account's buckets, as AWS Lambda gives a function its role's credentials. */
export interface FunctionCredentials {
  /** The key's ID: a new key is a new version of what the function's process gets. */
  keyId: string;
  /** AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_DEFAULT_REGION and AWS_ENDPOINT_URL_S3: AWS's SDKs read them all. */
  variables: Record<string, string>;
}

/**
 * Each function's own access key to its account's buckets (ADR 0009): made the
 * first time the function is deployed, reaching every bucket of the account,
 * read-write, and checked by the front door as any key is; revoked when the
 * function is deleted. It reaches the function's pods in their environment's
 * Secret, with the region and the front door's address inside the cluster,
 * where AWS's SDKs look for them, so that `new S3Client({})` and
 * `boto3.client("s3")` work unchanged. Short-lived credentials, as a Lambda
 * role's are, wait for an STS of FF's. Never listed with the account's own
 * keys, nor counted against their two.
 */
@Injectable()
export class FunctionKeys {
  private readonly endpoint: string;
  private readonly region: string;

  constructor(
    @InjectRepository(StorageKey) private readonly keys: Repository<StorageKey>,
    private readonly directory: StorageDirectory,
    config: ConfigService,
  ) {
    this.endpoint = config.get<string>('storage.functionEndpoint') ?? '';
    this.region = config.getOrThrow<string>('storage.region');
  }

  /** The function's key and where it reaches, the key made if it has none; undefined where FF gives functions none. */
  async credentialsFor(fn: { id: string; accountId: string }): Promise<FunctionCredentials | undefined> {
    if (!this.endpoint) return undefined;
    const key = (await this.keyOf(fn.id)) ?? (await this.make(fn));
    return {
      keyId: key.id,
      variables: {
        AWS_ACCESS_KEY_ID: key.id,
        AWS_SECRET_ACCESS_KEY: key.secret,
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        AWS_ENDPOINT_URL_S3: this.endpoint,
      },
    };
  }

  /** The function's key stops working at once: the front door refuses its next request. Nothing when it has none. */
  async revoke(functionId: string, manager: EntityManager = this.keys.manager): Promise<void> {
    await manager.update(StorageKey, { functionId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  private async keyOf(functionId: string): Promise<{ id: string; secret: string } | null> {
    const row = await this.keys.findOneBy({ functionId, revokedAt: IsNull() });
    return row && { id: row.id, secret: this.directory.secretOf(row) };
  }

  private async make(fn: { id: string; accountId: string }): Promise<{ id: string; secret: string }> {
    const id = newAccessKeyId();
    const secret = newSecretAccessKey();
    try {
      await this.keys.insert({ id, accountId: fn.accountId, functionId: fn.id, secret: this.directory.sealSecret(id, secret), buckets: null, readOnly: false });
      return { id, secret };
    } catch (error) {
      if (!(error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION)) throw error;
      // A function has one key that works, which its index keeps: the one the other deploy made.
      const made = await this.keyOf(fn.id);
      if (!made) throw error;
      return made;
    }
  }
}

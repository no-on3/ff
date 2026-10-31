import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, QueryFailedError, Repository } from 'typeorm';
import { AWS_ENDPOINTS, AwsEndpoint } from '../common/aws-endpoint';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from './storage-names';

/** PostgreSQL's unique_violation: another deploy of the function made its key meanwhile. */
const UNIQUE_VIOLATION = '23505';

/** The variable AWS's SDKs read each service's endpoint from. */
const ENDPOINT_VARIABLES: Record<AwsEndpoint, string> = {
  [AwsEndpoint.S3]: 'AWS_ENDPOINT_URL_S3',
  [AwsEndpoint.SQS]: 'AWS_ENDPOINT_URL_SQS',
  [AwsEndpoint.SESV2]: 'AWS_ENDPOINT_URL_SESV2',
};

/** What a function's pods get to reach its account's buckets, queues and mail, as AWS Lambda gives a function its role's credentials. */
export interface FunctionCredentials {
  /**
   * What the process gets, as a version: the key's ID, and the endpoints given
   * after a colon when they aren't all there are, none too; so that a new key,
   * or an endpoint more or less, rolls out.
   */
  revision: string;
  /** AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_DEFAULT_REGION, and AWS_ENDPOINT_URL_S3, _SQS and _SESV2 for the endpoints given: AWS's SDKs read them all. */
  variables: Record<string, string>;
}

/**
 * Each function's own access key to its account's buckets (ADR 0009), queues
 * (ADR 0010) and mail (ADR 0012): made the first time the function is
 * deployed, reaching every bucket and queue of the account, read-write, and
 * its mail, and checked as any key is; revoked when the function is deleted.
 * It reaches the function's pods in their environment's Secret, with the
 * region and the endpoints' addresses inside the cluster, where AWS's SDKs look
 * for them, so that `new S3Client({})`, `new SQSClient({})`,
 * `new SESv2Client({})` and boto3's `s3`, `sqs` and `sesv2` work unchanged. Short-lived credentials, as a Lambda
 * role's are, wait for an STS of FF's. Never listed with the account's own
 * keys, nor counted against their two. A function may leave an endpoint out
 * (its awsEndpoints), to reach that service at AWS while FF serves the others:
 * it still gets the key and the region, for those.
 */
@Injectable()
export class FunctionKeys {
  /** Where functions reach buckets' S3 front door, queues' SQS endpoint and mail's SES endpoint; '' for one they aren't given. */
  private readonly endpoints: Record<AwsEndpoint, string>;
  private readonly region: string;

  constructor(
    @InjectRepository(StorageKey) private readonly keys: Repository<StorageKey>,
    private readonly directory: StorageDirectory,
    config: ConfigService,
  ) {
    this.endpoints = {
      [AwsEndpoint.S3]: config.get<string>('storage.functionEndpoint') ?? '',
      [AwsEndpoint.SQS]: config.get<string>('sqs.functionEndpoint') ?? '',
      [AwsEndpoint.SESV2]: config.get<string>('ses.functionEndpoint') ?? '',
    };
    this.region = config.getOrThrow<string>('storage.region');
  }

  /**
   * The function's key and the endpoints it reaches of those it takes, the key
   * made if it has none; undefined where FF gives functions no endpoint. A
   * function deployed before an endpoint was given gets it at its next rollout.
   */
  async credentialsFor(fn: { id: string; accountId: string; awsEndpoints: readonly AwsEndpoint[] }): Promise<FunctionCredentials | undefined> {
    const offered = AWS_ENDPOINTS.filter((service) => this.endpoints[service]);
    if (offered.length === 0) return undefined;
    const given = offered.filter((service) => fn.awsEndpoints.includes(service));
    const key = (await this.keyOf(fn.id)) ?? (await this.make(fn));
    return {
      // The key's ID alone while the function takes every endpoint, as before one could be left out: no rollout for it.
      revision: given.length === offered.length ? key.id : `${key.id}:${given.join(',')}`,
      variables: {
        AWS_ACCESS_KEY_ID: key.id,
        AWS_SECRET_ACCESS_KEY: key.secret,
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        ...Object.fromEntries(given.map((service) => [ENDPOINT_VARIABLES[service], this.endpoints[service]])),
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

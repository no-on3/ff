import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';
import { AWS_ENDPOINTS, AwsEndpoint } from '../common/aws-endpoint';
import { isUniqueViolation } from '../common/unique-violation';
import { StorageDirectory } from './storage-directory.service';
import { StorageKey } from './storage-key.entity';
import { newAccessKeyId, newSecretAccessKey } from './storage-names';

/** How long a function's key works, as a Lambda role's session lasts at most (ADR 0014, 5). */
export const FUNCTION_KEY_LIFE_MS = 12 * 60 * 60 * 1000;

/** When a function's key is renewed: at half its life, which leaves the other half to replace the pods holding it. */
export function renewsAt(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - FUNCTION_KEY_LIFE_MS / 2);
}

/** Whether a key ending then is due its renewal now; a lasting one, made before keys ended, is at once. */
function isDueAt(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || renewsAt(expiresAt) <= now;
}

/** A function whose keys the renewal is for: its current key is due, or it has keys replaced that aren't revoked yet. */
export interface KeysToRenew {
  functionId: string;
  /** Its account, whose namespace has its pods. */
  accountId: string;
  /** Its current key is past half its life, or past its end, or lasting. */
  due: boolean;
  /** Its current key is lasting, made before keys ended: one that never ends on its own. */
  lasting: boolean;
  /** It has keys replaced, not revoked yet, which pods may still hold. */
  replaced: boolean;
}

/** The variable AWS's SDKs read each service's endpoint from. */
const ENDPOINT_VARIABLES: Record<AwsEndpoint, string> = {
  [AwsEndpoint.S3]: 'AWS_ENDPOINT_URL_S3',
  [AwsEndpoint.SQS]: 'AWS_ENDPOINT_URL_SQS',
  [AwsEndpoint.SESV2]: 'AWS_ENDPOINT_URL_SESV2',
  [AwsEndpoint.LAMBDA]: 'AWS_ENDPOINT_URL_LAMBDA',
};

/** What a function's pods get to reach its account's buckets, queues, mail and functions, as AWS Lambda gives a function its role's credentials. */
export interface FunctionCredentials {
  /**
   * What the process gets, as a version: the key's ID, and the endpoints given
   * after a colon when they aren't all there are, none too; so that a new key,
   * or an endpoint more or less, rolls out.
   */
  revision: string;
  /** AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_DEFAULT_REGION, and AWS_ENDPOINT_URL_S3, _SQS, _SESV2 and _LAMBDA for the endpoints given: AWS's SDKs read them all. */
  variables: Record<string, string>;
}

/**
 * Each function's own access key to its account's buckets (ADR 0009), queues
 * (ADR 0010), mail (ADR 0012) and functions (ADR 0014): made the first time the
 * function is deployed, reaching every bucket and queue of the account,
 * read-write, its mail, and its functions to invoke, and checked as any key
 * is; revoked when the function is deleted.
 * It works 12 hours, as a role's credentials do (ADR 0014, 5): past half its
 * life, the next workload made of the function has a new one, the old one
 * replaced, working on until the renewal finds no pod holding it and revokes
 * it. A key made before keys ended, which never ends on its own, is due at
 * once: the renewal replaces it, a function at zero too.
 * It reaches the function's pods in their environment's Secret, with the
 * region and the endpoints' addresses inside the cluster, where AWS's SDKs look
 * for them, so that `new S3Client({})`, `new SQSClient({})`, `new SESv2Client({})`,
 * `new LambdaClient({})` and boto3's `s3`, `sqs`, `sesv2` and `lambda` work unchanged, with no session token: the
 * renewal rolls the pods onto the new key. Never listed with the account's own
 * keys, nor counted against the plan's access keys. A function may leave an endpoint out
 * (its awsEndpoints), to reach that service at AWS while FF serves the others:
 * it still gets the key and the region, for those.
 */
@Injectable()
export class FunctionKeys {
  /** Where functions reach buckets' S3 front door, queues' SQS endpoint, mail's SES endpoint and Lambda's; '' for one they aren't given. */
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
      [AwsEndpoint.LAMBDA]: config.get<string>('lambda.functionEndpoint') ?? '',
    };
    this.region = config.getOrThrow<string>('storage.region');
  }

  /**
   * The function's key and the endpoints it reaches of those it takes, the key
   * made if it has none, and renewed past half its life; undefined where FF
   * gives functions no endpoint. A function deployed before an endpoint was
   * given gets it at its next rollout.
   */
  async credentialsFor(fn: { id: string; accountId: string; awsEndpoints: readonly AwsEndpoint[] }, now = new Date()): Promise<FunctionCredentials | undefined> {
    const offered = AWS_ENDPOINTS.filter((service) => this.endpoints[service]);
    if (offered.length === 0) return undefined;
    const given = offered.filter((service) => fn.awsEndpoints.includes(service));
    const key = await this.currentKey(fn, now);
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

  /** Whether the function's key is due a renewal, past half its life or its end, or lasting: a function at zero starts with a fresh one. */
  async isDue(functionId: string, now = new Date()): Promise<boolean> {
    const row = await this.keys.findOne({ where: { functionId, revokedAt: IsNull(), replacedAt: IsNull() }, select: { id: true, expiresAt: true } });
    return row !== null && isDueAt(row.expiresAt, now);
  }

  /** The functions the renewal is for, each once: those whose current key is due, lasting keys' included, and those with keys replaced not revoked yet. */
  async toRenew(now = new Date()): Promise<KeysToRenew[]> {
    // Past half its life is ending within the other half; a lasting key, with no end, is due at once.
    const dueBefore = new Date(now.getTime() + FUNCTION_KEY_LIFE_MS / 2);
    return this.keys.query(
      `SELECT "function_id" AS "functionId", "account_id" AS "accountId",
              bool_or("replaced_at" IS NULL AND ("expires_at" IS NULL OR "expires_at" <= $1)) AS "due",
              bool_or("replaced_at" IS NULL AND "expires_at" IS NULL) AS "lasting",
              bool_or("replaced_at" IS NOT NULL) AS "replaced"
         FROM "storage_keys"
        WHERE "function_id" IS NOT NULL AND "revoked_at" IS NULL
        GROUP BY "function_id", "account_id"
       HAVING bool_or("replaced_at" IS NULL AND ("expires_at" IS NULL OR "expires_at" <= $1)) OR bool_or("replaced_at" IS NOT NULL)
        ORDER BY "function_id"`,
      [dueBefore],
    );
  }

  /** The function's keys replaced stop working, once no pod holds them: how many. */
  async revokeReplaced(functionId: string, now = new Date()): Promise<number> {
    const { affected } = await this.keys.update({ functionId, replacedAt: Not(IsNull()), revokedAt: IsNull() }, { revokedAt: now });
    return affected ?? 0;
  }

  /** The function's lasting key stops working, for a function no pod runs, whose next rollout makes it a key that ends: how many, 0 or 1. */
  async revokeLasting(functionId: string, now = new Date()): Promise<number> {
    const { affected } = await this.keys.update({ functionId, expiresAt: IsNull(), replacedAt: IsNull(), revokedAt: IsNull() }, { revokedAt: now });
    return affected ?? 0;
  }

  /** The function's keys stop working at once, a current one and those replaced: the front door refuses their next request. Nothing when it has none. */
  async revoke(functionId: string, manager: EntityManager = this.keys.manager): Promise<void> {
    await manager.update(StorageKey, { functionId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  /** The function's key now: made when it has none, renewed past half its life, or when it is lasting, made before keys ended. */
  private async currentKey(fn: { id: string; accountId: string }, now: Date): Promise<{ id: string; secret: string }> {
    const row = await this.currentRow(fn.id);
    if (!row) return this.make(fn, now);
    if (isDueAt(row.expiresAt, now)) return this.renew(fn, row.id, now);
    return { id: row.id, secret: this.directory.secretOf(row) };
  }

  private currentRow(functionId: string): Promise<StorageKey | null> {
    return this.keys.findOneBy({ functionId, revokedAt: IsNull(), replacedAt: IsNull() });
  }

  private async keyOf(functionId: string): Promise<{ id: string; secret: string } | null> {
    const row = await this.currentRow(functionId);
    return row && { id: row.id, secret: this.directory.secretOf(row) };
  }

  private async make(fn: { id: string; accountId: string }, now: Date): Promise<{ id: string; secret: string }> {
    try {
      return await this.insert(fn, now, this.keys.manager);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A function has one current key, which its index keeps: the one the other deploy made.
      const made = await this.keyOf(fn.id);
      if (!made) throw error;
      return made;
    }
  }

  /**
   * A new key in the place of `current`, which is marked replaced in the same transaction, and works on. Two renewals
   * at once make one: the second waits for the first's row, finds it replaced, and takes the key the first made.
   */
  private async renew(fn: { id: string; accountId: string }, current: string, now: Date): Promise<{ id: string; secret: string }> {
    const made = await this.keys.manager.transaction(async (manager) => {
      const { affected } = await manager.update(StorageKey, { id: current, replacedAt: IsNull(), revokedAt: IsNull() }, { replacedAt: now });
      return affected ? this.insert(fn, now, manager) : null;
    });
    return made ?? (await this.keyOf(fn.id)) ?? this.make(fn, now);
  }

  private async insert(fn: { id: string; accountId: string }, now: Date, manager: EntityManager): Promise<{ id: string; secret: string }> {
    const id = newAccessKeyId();
    const secret = newSecretAccessKey();
    const expiresAt = new Date(now.getTime() + FUNCTION_KEY_LIFE_MS);
    await manager.insert(StorageKey, { id, accountId: fn.accountId, functionId: fn.id, secret: this.directory.sealSecret(id, secret), buckets: null, readOnly: false, expiresAt });
    return { id, secret };
  }
}

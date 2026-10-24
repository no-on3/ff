import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Actor } from '../common/request-context';
import { parseFunctionArn } from '../functions/arns';
import { Function } from '../functions/entities/function.entity';
import { Queue, QueueKind } from '../queues/queue.entity';
import { parseQueueArn } from '../queues/sqs-attributes';
import { BucketEvents } from './bucket-events';
import { NotificationConfigurationJson, NotificationRule, checkRules, rulesFromJson, rulesJson, testEvent } from './bucket-notifications';
import { Bucket, BucketStatus } from './bucket.entity';
import { S3Error } from './s3-error';

/** Who changed a configuration through the S3 front door: the access key, from its address; FF's API's caller is the request's own. */
export interface ChangedBy {
  actor?: Actor;
  ip?: string;
  requestId?: string;
}

/**
 * A bucket's notification configuration, as S3's (ADR 0010): the functions and
 * queues of the account its objects' events go to, set whole through the S3
 * front door or FF's API, checked as S3 checks it, each destination the
 * account's, in FF's region, and there unless the caller asks S3 to skip that
 * check; each change in the audit log; and S3's test event sent to each queue
 * a configuration names, as S3 sends it.
 */
@Injectable()
export class BucketNotificationsService {
  private readonly region: string;

  constructor(
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
    @InjectRepository(Function) private readonly functions: Repository<Function>,
    @InjectRepository(Queue) private readonly queues: Repository<Queue>,
    private readonly audit: AuditService,
    private readonly events: BucketEvents,
    config: ConfigService,
  ) {
    this.region = config.getOrThrow<string>('storage.region');
  }

  /** GET /buckets/:name/notifications: S3's configuration, in its JSON names. */
  async get(accountId: string, name: string): Promise<NotificationConfigurationJson> {
    return rulesJson((await this.bucketOf(accountId, name)).notifications ?? []);
  }

  /** PUT /buckets/:name/notifications: as S3's PutBucketNotificationConfiguration, the configuration replaced whole; S3's refusals as 400. */
  async put(accountId: string, name: string, json: Partial<NotificationConfigurationJson>): Promise<NotificationConfigurationJson> {
    const bucket = await this.bucketOf(accountId, name);
    try {
      await this.keep(bucket, rulesFromJson(json), {});
    } catch (error) {
      if (error instanceof S3Error) throw new BadRequestException(`${error.code}: ${error.message}`);
      throw error;
    }
    return this.get(accountId, name);
  }

  /**
   * Checks the rules and their destinations, keeps them, logs the change, and
   * sends S3's test event to each queue they name. A destination must be the
   * account's, in FF's region, whatever the caller asks; whether it is there
   * is skipped when the caller says so, as S3's x-amz-skip-destination-validation.
   */
  async keep(bucket: Bucket, rules: NotificationRule[], options: { skipDestinationValidation?: boolean; changedBy?: ChangedBy }): Promise<void> {
    checkRules(rules);
    const unknown: string[] = [];
    for (const rule of rules) {
      const named = rule.target === 'queue' ? parseQueueArn(rule.arn) : parseFunctionArn(rule.arn);
      if (!named) throw new S3Error(400, 'InvalidArgument', `The ARN is not well formed: ${rule.arn}`);
      if (named.accountId !== bucket.accountId || named.region !== this.region) {
        throw new S3Error(400, 'InvalidArgument', `A destination must be a ${rule.target} of the bucket's account, in ${this.region}: ${rule.arn}`);
      }
      if (!options.skipDestinationValidation && !(await this.exists(bucket.accountId, rule.target, named.name))) unknown.push(rule.arn);
    }
    if (unknown.length) {
      throw new S3Error(400, 'InvalidArgument', `Unable to validate the following destination configurations: ${unknown.join(', ')}: the account has no such function or queue`);
    }
    await this.buckets.update({ id: bucket.id }, { notifications: rules.length ? rules : null });
    const changedBy = options.changedBy ?? {};
    await this.audit.record({
      accountId: bucket.accountId,
      action: 'bucket.notifications',
      resource: `bucket:${bucket.name}`,
      details: { configurations: rules.map(({ id, target, arn, events, prefix, suffix }) => ({ id, target, arn, events, prefix, suffix })) },
      ...(changedBy.actor ? { actor: changedBy.actor } : {}),
      ...(changedBy.ip ? { ip: changedBy.ip } : {}),
    });
    const requestId = changedBy.requestId ?? randomUUID();
    for (const rule of rules.filter((candidate) => candidate.target === 'queue')) {
      await this.events.publish({ kind: 'test', accountId: bucket.accountId, bucket: bucket.name, queueArn: rule.arn, body: testEvent(bucket.name, requestId, new Date()) });
    }
  }

  private async exists(accountId: string, target: NotificationRule['target'], name: string): Promise<boolean> {
    return target === 'queue' ? this.queues.existsBy({ accountId, name, kind: QueueKind.CUSTOMER }) : this.functions.existsBy({ accountId, name });
  }

  private async bucketOf(accountId: string, name: string): Promise<Bucket> {
    const bucket = await this.buckets.findOneBy({ accountId, name, status: BucketStatus.ACTIVE });
    if (!bucket) throw new NotFoundException(`The account has no bucket named "${name}"`);
    return bucket;
  }
}

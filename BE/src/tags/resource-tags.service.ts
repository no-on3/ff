import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ResourceTag } from './resource-tag.entity';
import { tagsProblem } from './tag-rules';

/** What tags are put on: one of the account's functions or buckets, by its ID, and how the audit log names it. */
export interface Tagged {
  kind: 'function' | 'bucket';
  id: string;
  /** function:<id>, bucket:<name>, as the audit log names each of its other changes. */
  resource: string;
}

export const taggedFunction = (id: string): Tagged => ({ kind: 'function', id, resource: `function:${id}` });

export const taggedBucket = (bucket: { id: string; name: string }): Tagged => ({ kind: 'bucket', id: bucket.id, resource: `bucket:${bucket.name}` });

/** The column that names each kind's resource. */
const COLUMN = { function: 'functionId', bucket: 'bucketId' } as const;

const rowsOf = (tagged: Tagged) => ({ [COLUMN[tagged.kind]]: tagged.id });

/**
 * The tags on an account's functions and buckets, as AWS's: put, a key
 * already there taking its new value, or a bucket's replaced whole, as S3
 * replaces them; removed by key; read. Each change is in the audit log, and a
 * resource's tags change one request at a time, so that two can't pass its 50
 * together. A resource's tags go with it.
 */
@Injectable()
export class ResourceTagsService {
  constructor(
    @InjectRepository(ResourceTag) private readonly tags: Repository<ResourceTag>,
    private readonly audit: AuditService,
  ) {}

  /** The resource's tags, by key. */
  of(tagged: Tagged, manager: EntityManager = this.tags.manager): Promise<Record<string, string>> {
    return manager
      .find(ResourceTag, { where: rowsOf(tagged), order: { key: 'ASC' } })
      .then((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value])));
  }

  /** Puts tags on the account's resource; 400, nothing put, for one AWS wouldn't take, or past 50. */
  async tag(accountId: string, tagged: Tagged, tags: Record<string, string>): Promise<void> {
    await this.changing(tagged, async (manager) => {
      const problem = tagsProblem(await this.of(tagged, manager), tags);
      if (problem) throw new BadRequestException(problem);
      await this.put(manager, accountId, tagged, tags);
      await this.audit.record({ accountId, action: `${tagged.kind}.tag`, resource: tagged.resource, details: { tags } }, manager);
    });
  }

  /** The resource's tags replaced whole, as S3's PutBucketTagging replaces a bucket's; none removes them all. */
  async replace(accountId: string, tagged: Tagged, tags: Record<string, string>): Promise<void> {
    if (Object.keys(tags).length === 0) {
      await this.untag(accountId, tagged, Object.keys(await this.of(tagged)));
      return;
    }
    const problem = tagsProblem({}, tags);
    if (problem) throw new BadRequestException(problem);
    await this.changing(tagged, async (manager) => {
      await manager.delete(ResourceTag, rowsOf(tagged));
      await this.put(manager, accountId, tagged, tags);
      await this.audit.record({ accountId, action: `${tagged.kind}.tag`, resource: tagged.resource, details: { tags, replaced: true } }, manager);
    });
  }

  /** Removes the resource's tags of these keys; a key it hasn't is no error, as on AWS. */
  async untag(accountId: string, tagged: Tagged, keys: string[]): Promise<void> {
    await this.changing(tagged, async (manager) => {
      await manager.delete(ResourceTag, { ...rowsOf(tagged), key: In(keys) });
      await this.audit.record({ accountId, action: `${tagged.kind}.untag`, resource: tagged.resource, details: { keys: [...new Set(keys)].sort() } }, manager);
    });
  }

  /** A new resource's tags, checked first, in the transaction that makes it: its own audit entry names them. */
  async putNew(manager: EntityManager, accountId: string, tagged: Tagged, tags: Record<string, string>): Promise<void> {
    const problem = tagsProblem({}, tags);
    if (problem) throw new BadRequestException(problem);
    await this.put(manager, accountId, tagged, tags);
  }

  private async put(manager: EntityManager, accountId: string, tagged: Tagged, tags: Record<string, string>): Promise<void> {
    const rows = Object.entries(tags).map(([key, value]) => ({ accountId, ...rowsOf(tagged), key, value }));
    await manager.upsert(ResourceTag, rows, [COLUMN[tagged.kind], 'key']);
  }

  /** One change of a resource's tags at a time, in a transaction: a lock held until it ends. */
  private changing(tagged: Tagged, change: (manager: EntityManager) => Promise<void>): Promise<void> {
    return this.tags.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tags:${tagged.kind}:${tagged.id}`]);
      await change(manager);
    });
  }
}

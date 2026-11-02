import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ResourceTag } from './resource-tag.entity';
import { tagsProblem } from './tag-rules';

/**
 * The tags on an account's functions, as AWS's: put, a key already there
 * taking its new value; removed by key; read. Each change is in the audit log,
 * and a function's tags change one request at a time, so that two can't pass
 * its 50 together. A function's tags go with it.
 */
@Injectable()
export class ResourceTagsService {
  constructor(
    @InjectRepository(ResourceTag) private readonly tags: Repository<ResourceTag>,
    private readonly audit: AuditService,
  ) {}

  /** The function's tags, by key. */
  ofFunction(functionId: string, manager: EntityManager = this.tags.manager): Promise<Record<string, string>> {
    return manager
      .find(ResourceTag, { where: { functionId }, order: { key: 'ASC' } })
      .then((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value])));
  }

  /** Puts tags on the account's function; 400, nothing put, for one AWS wouldn't take, or past 50. */
  async tagFunction(accountId: string, functionId: string, tags: Record<string, string>): Promise<void> {
    await this.tags.manager.transaction(async (manager) => {
      await lockTags(manager, functionId);
      const problem = tagsProblem(await this.ofFunction(functionId, manager), tags);
      if (problem) throw new BadRequestException(problem);
      const rows = Object.entries(tags).map(([key, value]) => ({ accountId, functionId, key, value }));
      await manager.upsert(ResourceTag, rows, ['functionId', 'key']);
      await this.audit.record({ accountId, action: 'function.tag', resource: `function:${functionId}`, details: { tags } }, manager);
    });
  }

  /** Removes the function's tags of these keys; a key it hasn't is no error, as on AWS. */
  async untagFunction(accountId: string, functionId: string, keys: string[]): Promise<void> {
    await this.tags.manager.transaction(async (manager) => {
      await lockTags(manager, functionId);
      await manager.delete(ResourceTag, { functionId, key: In(keys) });
      await this.audit.record({ accountId, action: 'function.untag', resource: `function:${functionId}`, details: { keys: [...new Set(keys)].sort() } }, manager);
    });
  }
}

/** One change of a resource's tags at a time, until the transaction ends. */
function lockTags(manager: EntityManager, functionId: string): Promise<unknown> {
  return manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tags:function:${functionId}`]);
}

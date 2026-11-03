import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolation } from '../common/unique-violation';
import { Function } from '../functions/entities/function.entity';
import { Queue, QueueKind } from '../queues/queue.entity';
import { Bucket } from '../storage/bucket.entity';
import { PutStackDto, STACK_NAME, STACK_NAME_LENGTH, StackResourceDto, StackSummary, StackView } from './dto/stack.dto';
import { Stack, StackResource } from './stack.entity';

/** What of FF's a stack's resource can be. */
type Kind = 'function' | 'queue' | 'bucket';

/** The types whose resource is a function, a queue or a bucket of its own: its physical ID is that one's name. */
const OWN: Readonly<Record<string, Kind>> = {
  'AWS::Serverless::Function': 'function',
  'AWS::Lambda::Function': 'function',
  'AWS::SQS::Queue': 'queue',
  'AWS::S3::Bucket': 'bucket',
};

/** The types whose resource is a function's: its physical ID is the function's name, then a version's or an alias's after a colon. */
const OF_A_FUNCTION: ReadonlySet<string> = new Set(['AWS::Lambda::Url', 'AWS::Lambda::Alias', 'AWS::Lambda::Version', 'AWS::Lambda::EventInvokeConfig']);

/** The types a function of its own is made by. */
export const FUNCTION_TYPES = Object.keys(OWN).filter((type) => OWN[type] === 'function');

/** CloudFormation's most stacks in an account. */
export const MAX_STACKS = 2000;

/** The FF resource a stack's resource names, by its kind and its name; none for what FF keeps without effect. */
function named(resource: Pick<StackResource, 'type' | 'physicalId'>): { kind: Kind; name: string } | undefined {
  if (resource.physicalId === null) return undefined;
  const own = OWN[resource.type];
  if (own) return { kind: own, name: resource.physicalId };
  return OF_A_FUNCTION.has(resource.type) ? { kind: 'function', name: resource.physicalId.split(':')[0] } : undefined;
}

/** What a stack's resources hold twice: a logical ID, or one FF resource made by two of them. */
function repeated(resources: StackResourceDto[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const made = new Map<string, string>();
  for (const resource of resources) {
    if (ids.has(resource.logicalId)) problems.push(`${resource.logicalId} is given twice: a logical ID is a template's once`);
    ids.add(resource.logicalId);
    if (resource.physicalId === null) continue;
    const key = `${resource.type} ${resource.physicalId}`;
    const first = made.get(key);
    if (first !== undefined) problems.push(`${first} and ${resource.logicalId} are both the ${resource.type} ${resource.physicalId}: an FF resource is a stack's once`);
    else made.set(key, resource.logicalId);
  }
  return problems;
}

const notFound = (name: string) => new NotFoundException(`The account has no stack named "${name}"`);

const viewOf = (stack: Stack, resources: StackResource[]): StackView => ({
  name: stack.name,
  templateSha256: stack.templateSha256,
  parameters: stack.parameters,
  resources: resources
    .map(({ logicalId, type, physicalId }) => ({ logicalId, type, physicalId }))
    .sort((a, b) => (a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0)),
  createdAt: stack.createdAt,
  updatedAt: stack.updatedAt,
});

/**
 * An account's stacks (ADR 0016), FF's record of what `ff deploy` made of a
 * SAM template: the CLI reads the template, makes its resources through FF's
 * API, and puts the stack as it left it, whole; the next deploy reads it to
 * change what the template changed and remove what it no longer has. A stack
 * names only the account's functions, queues and buckets, each in one stack
 * at most. Forgetting a stack leaves what it made: `ff delete-stack` deletes
 * that first. Each change is in the audit log.
 */
@Injectable()
export class StacksService {
  constructor(
    @InjectRepository(Stack) private readonly stacks: Repository<Stack>,
    @InjectRepository(StackResource) private readonly resources: Repository<StackResource>,
    @InjectRepository(Function) private readonly functions: Repository<Function>,
    @InjectRepository(Queue) private readonly queues: Repository<Queue>,
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
    private readonly audit: AuditService,
  ) {}

  /** The account's stacks, by name, their resources counted. */
  async list(accountId: string): Promise<StackSummary[]> {
    const stacks = await this.stacks.find({ where: { accountId }, order: { name: 'ASC' } });
    const counts = await this.resources
      .createQueryBuilder('resource')
      .select('resource.stackId', 'stackId')
      .addSelect('COUNT(*)::int', 'count')
      .where('resource.accountId = :accountId', { accountId })
      .groupBy('resource.stackId')
      .getRawMany<{ stackId: string; count: number }>();
    const countOf = new Map(counts.map((row) => [row.stackId, row.count]));
    return stacks.map((stack) => ({
      name: stack.name,
      templateSha256: stack.templateSha256,
      resources: countOf.get(stack.id) ?? 0,
      createdAt: stack.createdAt,
      updatedAt: stack.updatedAt,
    }));
  }

  /** The account's stack, with each resource and what it made; 404 for another account's, as for none. */
  async get(accountId: string, name: string): Promise<StackView> {
    const stack = await this.stacks.findOne({ where: { accountId, name } });
    if (!stack) throw notFound(name);
    return viewOf(stack, await this.resources.find({ where: { stackId: stack.id } }));
  }

  /**
   * Puts the stack as a deploy left it, whole: made, or its parameters, its
   * template's SHA-256 and its resources replaced. 400, nothing changed, for a
   * name CloudFormation wouldn't take, a logical ID or an FF resource given
   * twice, or a function, a queue or a bucket the account hasn't; 409 for one
   * another of its stacks has.
   */
  async put(accountId: string, name: string, dto: PutStackDto): Promise<StackView> {
    if (!STACK_NAME.test(name) || name.length > STACK_NAME_LENGTH) {
      throw new BadRequestException(`A stack's name is letters, digits and hyphens, a letter first, ${STACK_NAME_LENGTH} at most, as CloudFormation's`);
    }
    const problems = [...repeated(dto.resources), ...(await this.missing(accountId, dto.resources))];
    if (problems.length) throw new BadRequestException(problems);
    const taken = await this.takenElsewhere(accountId, name, dto.resources);
    if (taken.length) throw new ConflictException(taken);
    try {
      return await this.stacks.manager.transaction((manager) => this.save(manager, accountId, name, dto));
    } catch (error) {
      // Another stack was given one of these resources between the check and the save.
      if (isUniqueViolation(error)) throw new ConflictException(`Another of the account's stacks was given one of these resources meanwhile: deploy again`);
      throw error;
    }
  }

  /** Forgets the account's stack, its resources' record with it; what they made stays. */
  async remove(accountId: string, name: string): Promise<void> {
    await this.stacks.manager.transaction(async (manager) => {
      const stack = await manager.findOne(Stack, { where: { accountId, name }, lock: { mode: 'pessimistic_write' } });
      if (!stack) throw notFound(name);
      const resources = await manager.count(StackResource, { where: { stackId: stack.id } });
      await manager.delete(Stack, { id: stack.id });
      await this.audit.record({ accountId, action: 'stack.delete', resource: `stack:${name}`, details: { resources } }, manager);
    });
  }

  /** The stack each of the account's functions named is in, by the function's name: none for one in no stack. */
  async ofFunctions(accountId: string, names: string[]): Promise<Map<string, string>> {
    if (names.length === 0) return new Map();
    const rows = await this.resources
      .createQueryBuilder('resource')
      .innerJoin(Stack, 'stack', 'stack.id = resource.stackId')
      .select('resource.physicalId', 'function')
      .addSelect('stack.name', 'stack')
      .where('resource.accountId = :accountId', { accountId })
      .andWhere('resource.type IN (:...types)', { types: FUNCTION_TYPES })
      .andWhere('resource.physicalId IN (:...names)', { names })
      .getRawMany<{ function: string; stack: string }>();
    return new Map(rows.map((row) => [row.function, row.stack]));
  }

  /** The stack's row and resources as the deploy left them, in the audit log with what changed. */
  private async save(manager: EntityManager, accountId: string, name: string, dto: PutStackDto): Promise<StackView> {
    const [row] = await manager.query<{ id: string; created: boolean }[]>(
      `INSERT INTO stacks (account_id, name, template_sha256, parameters) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, name) DO UPDATE SET template_sha256 = EXCLUDED.template_sha256, parameters = EXCLUDED.parameters, updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [accountId, name, dto.templateSha256, JSON.stringify(dto.parameters ?? {})],
    );
    if (row.created && (await manager.count(Stack, { where: { accountId } })) > MAX_STACKS) {
      throw new BadRequestException(`The account has ${MAX_STACKS.toLocaleString('en-US')} stacks, CloudFormation's most: delete one first`);
    }
    const before = await manager.find(StackResource, { where: { stackId: row.id } });
    await manager.delete(StackResource, { stackId: row.id });
    const resources = dto.resources.map((resource) => manager.create(StackResource, { ...resource, stackId: row.id, accountId }));
    if (resources.length) await manager.insert(StackResource, resources);
    const was = new Map(before.map((resource) => [resource.logicalId, resource]));
    const now = new Set(resources.map((resource) => resource.logicalId));
    await this.audit.record(
      {
        accountId,
        action: 'stack.put',
        resource: `stack:${name}`,
        details: {
          templateSha256: dto.templateSha256,
          created: row.created,
          added: resources.filter((resource) => !was.has(resource.logicalId)).map((resource) => resource.logicalId),
          changed: resources
            .filter((resource) => {
              const old = was.get(resource.logicalId);
              return old !== undefined && (old.type !== resource.type || old.physicalId !== resource.physicalId);
            })
            .map((resource) => resource.logicalId),
          removed: before.filter((resource) => !now.has(resource.logicalId)).map((resource) => resource.logicalId),
        },
      },
      manager,
    );
    const stack = await manager.findOneOrFail(Stack, { where: { id: row.id } });
    return viewOf(stack, resources);
  }

  /** The resources naming a function, a queue or a bucket the account hasn't: another account's is not the stack's to name. */
  private async missing(accountId: string, resources: StackResourceDto[]): Promise<string[]> {
    const wanted: Record<Kind, Set<string>> = { function: new Set(), queue: new Set(), bucket: new Set() };
    for (const resource of resources) {
      const target = named(resource);
      if (target) wanted[target.kind].add(target.name);
    }
    const select = { name: true } as const;
    const [functions, queues, buckets] = await Promise.all([
      wanted.function.size ? this.functions.find({ select, where: { accountId, name: In([...wanted.function]) } }) : [],
      wanted.queue.size ? this.queues.find({ select, where: { accountId, kind: QueueKind.CUSTOMER, name: In([...wanted.queue]) } }) : [],
      wanted.bucket.size ? this.buckets.find({ select, where: { accountId, name: In([...wanted.bucket]) } }) : [],
    ]);
    const has: Record<Kind, Set<string>> = {
      function: new Set(functions.map((row) => row.name)),
      queue: new Set(queues.map((row) => row.name)),
      bucket: new Set(buckets.map((row) => row.name)),
    };
    return resources.flatMap((resource) => {
      const target = named(resource);
      return target && !has[target.kind].has(target.name) ? [`${resource.logicalId}: the account has no ${target.kind} named "${target.name}"`] : [];
    });
  }

  /** The functions, queues and buckets of these resources that another of the account's stacks has, named with that stack. */
  private async takenElsewhere(accountId: string, name: string, resources: StackResourceDto[]): Promise<string[]> {
    const own = resources.filter((resource) => resource.physicalId !== null && OWN[resource.type] !== undefined);
    if (own.length === 0) return [];
    const others = await this.resources
      .createQueryBuilder('resource')
      .innerJoin(Stack, 'stack', 'stack.id = resource.stackId')
      .select(['resource.logicalId AS "logicalId"', 'resource.type AS "type"', 'resource.physicalId AS "physicalId"', 'stack.name AS "stack"'])
      .where('resource.accountId = :accountId', { accountId })
      .andWhere('stack.name <> :name', { name })
      .andWhere('resource.type IN (:...types)', { types: Object.keys(OWN) })
      .andWhere('resource.physicalId IN (:...ids)', { ids: own.map((resource) => resource.physicalId) })
      .getRawMany<{ logicalId: string; type: string; physicalId: string; stack: string }>();
    return own.flatMap((resource) => {
      const kind = OWN[resource.type];
      const other = others.find((row) => OWN[row.type] === kind && row.physicalId === resource.physicalId);
      return other
        ? [`${resource.logicalId}: the ${kind} "${resource.physicalId}" is the stack ${other.stack}'s, its ${other.logicalId}: a function, a queue or a bucket is in one stack at most`]
        : [];
    });
  }
}

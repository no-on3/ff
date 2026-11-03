import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { FunctionPolicyStatement } from './entities/function-policy-statement.entity';
import { lockedFunction } from './locked-function';
import { hasQualifier, parseQualifier, qualifierDetail, qualifierText, storedQualifier } from './qualifier';

/** The most a policy holds, as Lambda's: 20 KB of JSON, its statements together. */
export const POLICY_MAX_BYTES = 20_480;

/** A policy as GetPolicy gives it back: Lambda's document, its statements in the order they came. */
export const policyDocument = (statements: ReadonlyArray<Record<string, unknown>>): string =>
  JSON.stringify({ Version: '2012-10-17', Id: 'default', Statement: statements });

/** The statements of one policy: the function's own, or its version's or alias's, as `qualifier` names it. */
function policyOf(functionId: string, qualifier: string | undefined): FindOptionsWhere<FunctionPolicyStatement> {
  const named = parseQualifier(qualifier);
  return {
    functionId,
    version: named && 'version' in named ? named.version : IsNull(),
    alias: named && 'alias' in named ? named.alias : IsNull(),
  };
}

/**
 * Lambda's permissions on a function (ADR 0014): statements kept as sent and
 * given back, without effect, in the function's own policy or in its
 * version's or alias's, each ID once in its policy, 20 KB of them at most.
 * A change runs under the function's lock, as its versions and aliases
 * change, and goes in the audit log.
 */
@Injectable()
export class FunctionPoliciesService {
  constructor(
    @InjectRepository(FunctionPolicyStatement) private readonly statements: Repository<FunctionPolicyStatement>,
    private readonly audit: AuditService,
  ) {}

  /** The policy's statements, in the order they came; none for a policy that has none. */
  async policy(accountId: string, functionId: string, qualifier?: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.statements.find({ where: { ...policyOf(functionId, qualifier), accountId }, order: { createdAt: 'ASC', id: 'ASC' } });
    return rows.map((row) => row.statement);
  }

  /** A statement added, as sent; an ID its policy has already, or a policy grown past its size, refused in Lambda's words. */
  async add(accountId: string, functionId: string, qualifier: string | undefined, statementId: string, statement: Record<string, unknown>): Promise<void> {
    await this.statements.manager.transaction(async (manager) => {
      await lockedFunction(manager, accountId, functionId);
      // Found before, the version or the alias may have been deleted since: under the lock, it stays as found now.
      if (!(await hasQualifier(manager, functionId, qualifier))) throw new NotFoundException(`The function has no ${qualifierText(qualifier)}`);
      const where = policyOf(functionId, qualifier);
      const held = await manager.find(FunctionPolicyStatement, { where, order: { createdAt: 'ASC', id: 'ASC' } });
      if (held.some((row) => row.statementId === statementId)) {
        throw new ConflictException(`The statement id (${statementId}) provided already exists. Please provide a new statement id, or remove the existing statement.`);
      }
      const size = Buffer.byteLength(policyDocument([...held.map((row) => row.statement), statement]));
      if (size > POLICY_MAX_BYTES) {
        throw new BadRequestException({ statusCode: 400, error: 'PolicyLengthExceededException', message: `The final policy size (${size}) is bigger than the limit (${POLICY_MAX_BYTES}).` });
      }
      const stored = parseQualifier(qualifier);
      await manager.save(FunctionPolicyStatement, {
        accountId,
        functionId,
        version: stored && 'version' in stored ? stored.version : null,
        alias: stored && 'alias' in stored ? stored.alias : null,
        statementId,
        statement,
      });
      const details = { statementId, ...qualifierDetail(storedQualifier(qualifier)) };
      await this.audit.record({ accountId, action: 'function.add_permission', resource: `function:${functionId}`, details }, manager);
    });
  }

  /** A statement removed by its ID; one its policy hasn't, refused in Lambda's words. */
  async remove(accountId: string, functionId: string, qualifier: string | undefined, statementId: string): Promise<void> {
    await this.statements.manager.transaction(async (manager) => {
      await lockedFunction(manager, accountId, functionId);
      const { affected } = await manager.delete(FunctionPolicyStatement, { ...policyOf(functionId, qualifier), statementId });
      if (!affected) throw new NotFoundException(`Statement ${statementId} is not found in resource policy.`);
      const details = { statementId, ...qualifierDetail(storedQualifier(qualifier)) };
      await this.audit.record({ accountId, action: 'function.remove_permission', resource: `function:${functionId}`, details }, manager);
    });
  }
}

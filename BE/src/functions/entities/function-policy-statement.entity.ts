import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { FunctionAlias } from './function-alias.entity';
import { FunctionVersion } from './function-version.entity';
import { Function } from './function.entity';

/**
 * A statement of a function's resource-based policy, as Lambda's AddPermission
 * adds one: kept as sent and given back by GetPolicy, without effect, since
 * FF's own rules decide who calls a function (ADR 0014). As on Lambda, the
 * function has a policy, and each of its versions and aliases one of its own,
 * each statement's ID once in each. Deleting the function, the version or the
 * alias deletes its statements.
 */
@Entity('function_policies')
@Check(`"version" IS NULL OR "alias" IS NULL`)
@Index(['functionId', 'version', 'statementId'], { unique: true })
@Index(['functionId', 'alias', 'statementId'], { unique: true })
// The function's own policy: the indexes above never repeat a null version or alias, this one does.
@Index('UQ_function_policies_function', ['functionId', 'statementId'], { unique: true, where: `"version" IS NULL AND "alias" IS NULL` })
export class FunctionPolicyStatement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  @Column('uuid')
  functionId: string;

  @ManyToOne(() => Function, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'function_id' })
  function?: Function;

  /** The version whose policy it is in; null for the function's own or an alias's. */
  @Column({ type: 'integer', nullable: true })
  version: number | null;

  @ManyToOne(() => FunctionVersion, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'function_id', referencedColumnName: 'functionId' },
    { name: 'version', referencedColumnName: 'version' },
  ])
  versionOf?: FunctionVersion;

  /** The alias whose policy it is in; null for the function's own or a version's. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  alias: string | null;

  @ManyToOne(() => FunctionAlias, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'function_id', referencedColumnName: 'functionId' },
    { name: 'alias', referencedColumnName: 'name' },
  ])
  aliasOf?: FunctionAlias;

  /** Lambda's StatementId, the statement's Sid: up to 100 letters, digits, hyphens and underscores. */
  @Column({ type: 'varchar', length: 100 })
  statementId: string;

  /** The statement as GetPolicy gives it back: Lambda's JSON, its Sid, Effect, Principal, Action, Resource and Condition. */
  @Column({ type: 'jsonb' })
  statement: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}

import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A stack (ADR 0016): what `ff deploy` made of a SAM template, under a name of
 * the account's, as CloudFormation keeps a stack: the parameters' values it
 * was deployed with, the template's SHA-256, to tell when it changed, and its
 * resources. Not the template's text, which stays the customer's, in their
 * repository. Its resources go with it; the FF resources they made stay.
 */
@Entity('stacks')
@Index(['accountId', 'name'], { unique: true })
export class Stack {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** CloudFormation's: letters, digits and hyphens, a letter first, 128 at most. */
  @Column({ type: 'varchar', length: 128 })
  name: string;

  /** The template's SHA-256, in hexadecimal: another says the template changed. */
  @Column({ type: 'char', length: 64 })
  templateSha256: string;

  /** The parameters' values it was deployed with, by name; a NoEcho one's is left out, FF keeping no copy. */
  @Column({ type: 'jsonb' })
  parameters: Record<string, string>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * A resource of a stack: its logical ID in the template, its type, and the FF
 * resource it made, as CloudFormation's physical ID names one; null for what
 * FF keeps without effect. One FF resource of a type is in one of the
 * account's stacks at most.
 */
@Entity('stack_resources')
@Index(['accountId', 'type', 'physicalId'], { unique: true, where: '"physical_id" IS NOT NULL' })
export class StackResource {
  @PrimaryColumn('uuid')
  stackId: string;

  @ManyToOne(() => Stack, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stack_id' })
  stack?: Stack;

  /** CloudFormation's: letters and digits, 255 at most. */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  logicalId: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** As the template names it, AWS::Serverless::Function… */
  @Column({ type: 'varchar', length: 256 })
  type: string;

  /** A function's, a queue's or a bucket's name, a version's or an alias's after a colon; null for what has no effect on FF. */
  @Column({ type: 'varchar', length: 1024, nullable: true })
  physicalId: string | null;
}

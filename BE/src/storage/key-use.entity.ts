import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { AwsEndpoint } from '../common/aws-endpoint';

/**
 * What a key used of its account's buckets, queues and mail: the bucket, the
 * queue or the e-mail identity it reached, by which of the service's
 * operations, on the first and the last day it did. The front doors note each
 * use the first time it comes in a day (KeyUses). Its holder is the function
 * for a function's own key, so that its uses stay together when its key is
 * replaced, and the key itself for one of the account's own. The export makes
 * each function's role of these, granting what it used alone, as SAM's policy
 * templates tell a queue's poller from its sender, which read and write
 * wouldn't; and it says which of the account's keys are still in use.
 */
@Entity('key_uses')
@Index(['accountId', 'lastDay'])
export class KeyUse {
  /** The function's ID, for a function's own key; else the key's ID. */
  @PrimaryColumn({ type: 'varchar', length: 36 })
  holder: string;

  @PrimaryColumn({ type: 'enum', enum: AwsEndpoint })
  service: AwsEndpoint;

  /** The bucket's name, the queue's, or the e-mail identity or sender's address; '' for the account's own, such as ListBuckets. */
  @PrimaryColumn({ type: 'varchar', length: 320 })
  resource: string;

  /** The service's operation, as the service names it: GetObject, SendMessage, SendEmail. */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  operation: string;

  @Column({ type: 'char', length: 12 })
  accountId: string;

  /** The UTC days, as YYYY-MM-DD. */
  @Column({ type: 'date' })
  firstDay: string;

  @Column({ type: 'date' })
  lastDay: string;
}

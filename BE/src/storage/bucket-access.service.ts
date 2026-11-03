import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PublicAccessBlock } from './bucket-access';
import { ChangedBy, bucketChange } from './bucket-changes';
import { Bucket } from './bucket.entity';

/**
 * A bucket's policy and its public access block, as S3 keeps them, set and
 * removed through the S3 front door, without effect on FF: a bucket is public
 * through its website configuration alone, at its site's address, and its S3
 * API is signed whatever its policy says. They are kept for the move to AWS,
 * where a site's bucket needs both, so that the same Terraform module applies
 * on each, and a plan finds nothing to change. Each change in the audit log.
 */
@Injectable()
export class BucketAccessService {
  constructor(
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
    private readonly audit: AuditService,
  ) {}

  /** Keeps the bucket's policy as sent, or none. */
  async keepPolicy(bucket: Bucket, policy: string | null, changedBy: ChangedBy): Promise<void> {
    await this.buckets.update({ id: bucket.id }, { policy });
    await this.audit.record(bucketChange(bucket, 'bucket.policy', policy === null ? { removed: true } : { policy: JSON.parse(policy) as unknown }, changedBy));
  }

  /** Keeps the bucket's public access block, or none. */
  async keepPublicAccessBlock(bucket: Bucket, block: PublicAccessBlock | null, changedBy: ChangedBy): Promise<void> {
    await this.buckets.update({ id: bucket.id }, { publicAccessBlock: block });
    await this.audit.record(bucketChange(bucket, 'bucket.public_access_block', block === null ? { removed: true } : { ...block }, changedBy));
  }
}

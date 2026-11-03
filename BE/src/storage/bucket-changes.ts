import { AuditAction, AuditEvent } from '../audit/audit.service';
import { Actor } from '../common/request-context';
import { Bucket } from './bucket.entity';

/** Who changed a bucket's setting through the S3 front door: the access key, from its address; FF's API's caller is the request's own. */
export interface ChangedBy {
  actor?: Actor;
  ip?: string;
  requestId?: string;
}

/** A change to a bucket's setting, as the audit log records it: under whoever made it, the request's caller when nobody is named. */
export function bucketChange(bucket: Pick<Bucket, 'accountId' | 'name'>, action: AuditAction, details: Record<string, unknown>, changedBy: ChangedBy): AuditEvent {
  return {
    accountId: bucket.accountId,
    action,
    resource: `bucket:${bucket.name}`,
    details,
    ...(changedBy.actor ? { actor: changedBy.actor } : {}),
    ...(changedBy.ip ? { ip: changedBy.ip } : {}),
  };
}

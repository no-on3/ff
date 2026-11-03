import { S3Error } from './s3-error';
import { S3_NAMESPACE, XML_DECLARATION, escapeXml } from './xml';

/** One of a bucket's settings FF's buckets don't have: S3's query parameter that reads it, and S3's answer for a bucket without it. */
interface Unset {
  parameter: string;
  /** The document S3 gives, or its error, the bucket's owner given. */
  answer: (owner: string) => string | S3Error;
}

const empty = (root: string) => () => `${XML_DECLARATION}<${root} xmlns="${S3_NAMESPACE}"/>`;
const missing = (code: string, message: string) => () => new S3Error(404, code, message);

/** The owner's full control, the one grant of a bucket whose owner owns every object, as S3's are since 2023. */
function ownerOnlyAcl(owner: string): string {
  const id = `<ID>${escapeXml(owner)}</ID><DisplayName>${escapeXml(owner)}</DisplayName>`;
  return (
    `${XML_DECLARATION}<AccessControlPolicy xmlns="${S3_NAMESPACE}"><Owner>${id}</Owner><AccessControlList>` +
    `<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">${id}</Grantee><Permission>FULL_CONTROL</Permission></Grant>` +
    `</AccessControlList></AccessControlPolicy>`
  );
}

/**
 * S3's reads of a bucket's settings that FF's buckets don't have, by S3's
 * name for each, answered as S3 answers a bucket that has none, so that a
 * tool reading every one of them, as Terraform's provider does at each plan,
 * reads what is so: no policy, CORS, lifecycle, replication, Object Lock or
 * encryption of its own; versioning, acceleration and logging never turned
 * on; the owner paying for requests, and owning every object, without ACLs.
 */
export const UNSET_SETTINGS: Record<string, Unset> = {
  GetBucketPolicy: { parameter: 'policy', answer: missing('NoSuchBucketPolicy', 'The bucket policy does not exist') },
  GetBucketAcl: { parameter: 'acl', answer: ownerOnlyAcl },
  GetBucketCors: { parameter: 'cors', answer: missing('NoSuchCORSConfiguration', 'The CORS configuration does not exist') },
  GetBucketVersioning: { parameter: 'versioning', answer: empty('VersioningConfiguration') },
  GetBucketAccelerateConfiguration: { parameter: 'accelerate', answer: empty('AccelerateConfiguration') },
  GetBucketRequestPayment: {
    parameter: 'requestPayment',
    answer: () => `${XML_DECLARATION}<RequestPaymentConfiguration xmlns="${S3_NAMESPACE}"><Payer>BucketOwner</Payer></RequestPaymentConfiguration>`,
  },
  GetBucketLogging: { parameter: 'logging', answer: empty('BucketLoggingStatus') },
  GetBucketLifecycleConfiguration: { parameter: 'lifecycle', answer: missing('NoSuchLifecycleConfiguration', 'The lifecycle configuration does not exist') },
  GetBucketReplication: { parameter: 'replication', answer: missing('ReplicationConfigurationNotFoundError', 'The replication configuration was not found') },
  GetBucketEncryption: {
    parameter: 'encryption',
    answer: missing('ServerSideEncryptionConfigurationNotFoundError', 'The server side encryption configuration was not found'),
  },
  GetObjectLockConfiguration: { parameter: 'object-lock', answer: missing('ObjectLockConfigurationNotFoundError', 'Object Lock configuration does not exist for this bucket') },
  GetBucketOwnershipControls: {
    parameter: 'ownershipControls',
    answer: () =>
      `${XML_DECLARATION}<OwnershipControls xmlns="${S3_NAMESPACE}"><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>`,
  },
};

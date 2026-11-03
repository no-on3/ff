import { IncomingHttpHeaders } from 'node:http';
import { single } from '../common/http-request';
import { S3Error, malformedXml, notImplemented } from './s3-error';
import { bucketNameProblem } from './storage-names';
import { readS3Document } from './xml-reader';

/** The headers that grant others access to a bucket by ACL, which FF's buckets don't have. */
const GRANTS = ['x-amz-grant-full-control', 'x-amz-grant-read', 'x-amz-grant-read-acp', 'x-amz-grant-write', 'x-amz-grant-write-acp'];

export const invalidBucketName = (problem: string) => new S3Error(400, 'InvalidBucketName', `The specified bucket is not valid: ${problem}`);

export const bucketAlreadyExists = () =>
  new S3Error(409, 'BucketAlreadyExists', 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.');

export const bucketAlreadyOwnedByYou = () =>
  new S3Error(409, 'BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');

/** A location that isn't FF's region, refused as S3 refuses one at another region's endpoint. */
const illegalLocation = (location: string) =>
  new S3Error(400, 'IllegalLocationConstraintException', `The ${location} location constraint is incompatible for the region specific endpoint this request was sent to.`);

/**
 * CreateBucket's request, checked as S3 checks one at FF's regional endpoint:
 * the name by AWS's rules, as FF's API checks it; the configuration's
 * location, when it gives one, FF's region; the bucket's owner owning every
 * object, without ACLs, as S3's new buckets do; no Object Lock and no
 * directory bucket. A request without a location makes the bucket in FF's
 * region, as FF has no other.
 */
export function checkCreateBucket(name: string, headers: IncomingHttpHeaders, configuration: string, region: string): void {
  const problem = bucketNameProblem(name);
  if (problem) throw invalidBucketName(problem);
  const acl = single(headers['x-amz-acl']);
  if ((acl !== undefined && acl !== 'private') || GRANTS.some((grant) => headers[grant] !== undefined)) {
    throw new S3Error(400, 'InvalidBucketAclWithObjectOwnership', "Bucket cannot have ACLs set with ObjectOwnership's BucketOwnerEnforced setting");
  }
  const ownership = single(headers['x-amz-object-ownership']);
  if (ownership !== undefined && ownership !== 'BucketOwnerEnforced') {
    throw notImplemented("FF's buckets are BucketOwnerEnforced: their owner owns every object, without ACLs");
  }
  if (single(headers['x-amz-bucket-object-lock-enabled'])?.toLowerCase() === 'true') throw notImplemented("FF's buckets have no Object Lock");
  const namespace = single(headers['x-amz-bucket-namespace']);
  if (namespace !== undefined && namespace !== 'global') throw notImplemented("FF's bucket names are unique across FF, as in S3's global namespace");
  if (configuration.trim() === '') return;
  for (const element of readS3Document(configuration, 'CreateBucketConfiguration').children) {
    const location = element.text.trim();
    if (element.name === 'LocationConstraint') {
      if (location !== '' && location !== region) throw illegalLocation(location);
    } else if (element.name === 'Location' || element.name === 'Bucket') {
      throw notImplemented("FF's buckets are general purpose buckets: it has no directory buckets");
    } else if (element.name === 'Tags') {
      throw notImplemented("FF keeps a bucket's tags from PutBucketTagging, not yet from CreateBucket");
    } else {
      throw malformedXml();
    }
  }
}

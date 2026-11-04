import { checkCreateBucket } from './create-bucket';
import { S3Error } from './s3-error';

const REGION = 'tn-tunis-1';
const configuration = (inside: string) => `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inside}</CreateBucketConfiguration>`;

/** The check's outcome: accepted, or S3's code, status and message. */
const outcome = (name: string, headers: Record<string, string> = {}, document = ''): string => {
  try {
    const tags = checkCreateBucket(name, headers, document, REGION);
    return Object.keys(tags).length ? `accepted ${JSON.stringify(tags)}` : 'accepted';
  } catch (error) {
    if (!(error instanceof S3Error)) throw error;
    return `${error.status} ${error.code}: ${error.message}`;
  }
};

describe("CreateBucket's request, as S3 checks one at FF's regional endpoint", () => {
  it("takes FF's region as its location, or no location at all, which FF's only region then is", () => {
    expect(outcome('photos', {}, configuration(`<LocationConstraint>${REGION}</LocationConstraint>`))).toBe('accepted');
    expect(outcome('photos', {}, configuration(`<LocationConstraint>\n  ${REGION}\n</LocationConstraint>`))).toBe('accepted');
    expect(outcome('photos', {}, configuration('<LocationConstraint/>'))).toBe('accepted');
    expect(outcome('photos', {}, '')).toBe('accepted');
    expect(outcome('photos', {}, '  \n')).toBe('accepted');
  });

  it('refuses another region in S3\'s words', () => {
    expect(outcome('photos', {}, configuration('<LocationConstraint>eu-west-1</LocationConstraint>'))).toBe(
      '400 IllegalLocationConstraintException: The eu-west-1 location constraint is incompatible for the region specific endpoint this request was sent to.',
    );
  });

  it("refuses a name AWS wouldn't take, saying why, as FF's API does", () => {
    expect(outcome('My.Photos')).toMatch(/^400 InvalidBucketName: The specified bucket is not valid: "My.Photos" is not a bucket name: 3 to 63 lower-case letters/);
    expect(outcome('xn--photos')).toBe('400 InvalidBucketName: The specified bucket is not valid: "xn--photos" is not a bucket name: AWS keeps names with "xn--" for itself');
  });

  it("takes the private ACL and BucketOwnerEnforced, S3's defaults; refuses any other ACL or grant, as S3 does on a bucket whose owner owns every object", () => {
    expect(outcome('photos', { 'x-amz-acl': 'private', 'x-amz-object-ownership': 'BucketOwnerEnforced' })).toBe('accepted');
    const others: Array<Record<string, string>> = [{ 'x-amz-acl': 'public-read' }, { 'x-amz-grant-read': 'uri="http://acs.amazonaws.com/groups/global/AllUsers"' }];
    for (const headers of others) {
      expect(outcome('photos', headers)).toBe("400 InvalidBucketAclWithObjectOwnership: Bucket cannot have ACLs set with ObjectOwnership's BucketOwnerEnforced setting");
    }
  });

  it('takes its tags, as S3 keeps them with the bucket; refuses a key twice, or a tag AWS would refuse, InvalidTag', () => {
    const tag = (key: string, value: string) => `<Tag><Key>${key}</Key><Value>${value}</Value></Tag>`;
    expect(outcome('photos', {}, configuration(`<LocationConstraint>${REGION}</LocationConstraint><Tags>${tag('team', 'web')}${tag('stage', '')}</Tags>`))).toBe(
      'accepted {"team":"web","stage":""}',
    );
    expect(outcome('photos', {}, configuration(`<Tags>${tag('team', 'web')}${tag('team', 'shop')}</Tags>`))).toBe('400 InvalidTag: Cannot provide multiple Tags with the same key');
    expect(outcome('photos', {}, configuration(`<Tags>${tag('aws:owner', 'x')}</Tags>`))).toBe('400 InvalidTag: The key aws:owner starts with aws:, which AWS keeps for its own tags.');
  });

  it("refuses what FF's buckets don't have, NotImplemented, saying so: ACLs' ownership, Object Lock, an account's own namespace, directory buckets", () => {
    expect(outcome('photos', { 'x-amz-object-ownership': 'ObjectWriter' })).toBe("501 NotImplemented: FF's buckets are BucketOwnerEnforced: their owner owns every object, without ACLs");
    expect(outcome('photos', { 'x-amz-bucket-object-lock-enabled': 'True' })).toBe("501 NotImplemented: FF's buckets have no Object Lock");
    expect(outcome('photos', { 'x-amz-bucket-object-lock-enabled': 'false', 'x-amz-bucket-namespace': 'global' })).toBe('accepted');
    expect(outcome('photos', { 'x-amz-bucket-namespace': 'account-regional' })).toBe("501 NotImplemented: FF's bucket names are unique across FF, as in S3's global namespace");
    expect(outcome('photos', {}, configuration('<Location><Type>AvailabilityZone</Type><Name>use1-az4</Name></Location>'))).toMatch(/^501 NotImplemented: FF's buckets are general purpose/);
    expect(outcome('photos', {}, configuration('<Bucket><Type>Directory</Type></Bucket>'))).toMatch(/^501 NotImplemented: FF's buckets are general purpose/);
  });

  it('refuses a document that is no CreateBucketConfiguration, or holds what S3\'s has not, MalformedXML', () => {
    const malformed = '400 MalformedXML: The XML you provided was not well-formed or did not validate against our published schema';
    expect(outcome('photos', {}, '<WebsiteConfiguration/>')).toBe(malformed);
    expect(outcome('photos', {}, configuration('<Region>tn-tunis-1</Region>'))).toBe(malformed);
    expect(outcome('photos', {}, '<CreateBucketConfiguration><LocationConstraint>')).toBe(malformed);
  });
});

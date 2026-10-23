import { addressOf, operationOf } from './s3-requests';

const HOST = 's3.ffunc.tn';

describe("a request's bucket and key", () => {
  it('virtual-hosted, as the SDK for JavaScript addresses a host name', () => {
    expect(addressOf('photos.s3.ffunc.tn', '/2026/a%20b.jpg', HOST)).toEqual({ style: 'virtual-hosted', bucket: 'photos', rawKey: '2026/a%20b.jpg' });
    expect(addressOf('Photos.S3.ffunc.tn:443', '/', HOST)).toEqual({ style: 'virtual-hosted', bucket: 'photos', rawKey: '' });
  });

  it('path-style, as boto3 and the CLI address any endpoint and every SDK an IP address', () => {
    expect(addressOf('s3.ffunc.tn', '/photos/2026/a%20b.jpg', HOST)).toEqual({ style: 'path', bucket: 'photos', rawKey: '2026/a%20b.jpg' });
    expect(addressOf('10.43.0.12:3002', '/photos', HOST)).toEqual({ style: 'path', bucket: 'photos', rawKey: '' });
    expect(addressOf('s3.ffunc.tn', '/', HOST)).toEqual({ style: 'path', bucket: '', rawKey: '' });
    expect(addressOf('s3.ffunc.tn', '/photos//double', HOST).rawKey).toBe('/double');
  });

  it('a host two labels deeper is no bucket of FF\'s: path-style, so its path names the bucket', () => {
    expect(addressOf('a.b.s3.ffunc.tn', '/photos/x', HOST)).toEqual({ style: 'path', bucket: 'photos', rawKey: 'x' });
  });
});

describe('the operation a request is', () => {
  const bucket = { style: 'path' as const, bucket: 'photos', rawKey: '' };
  const object = { ...bucket, rawKey: 'a.jpg' };
  const of = (method: string, address: typeof bucket, query = '', headers: Record<string, string> = {}) => {
    const operation = operationOf(method, address, new URLSearchParams(query), headers);
    return `${operation.name} ${operation.class}${operation.writes ? ' writes' : ''}`;
  };

  it("the bucket's: listings, its location, the bucket itself, a batch of deletes", () => {
    expect(of('GET', { ...bucket, bucket: '' })).toBe('ListBuckets tier1');
    expect(of('GET', bucket, 'list-type=2&prefix=2026%2F&delimiter=%2F&max-keys=100&x-id=ListObjectsV2')).toBe('ListObjectsV2 tier1');
    expect(of('GET', bucket)).toBe('ListObjects tier1');
    expect(of('GET', bucket, 'marker=a')).toBe('ListObjects tier1');
    expect(of('GET', bucket, 'location')).toBe('GetBucketLocation tier2');
    expect(of('GET', bucket, 'uploads&prefix=a')).toBe('ListMultipartUploads tier1');
    expect(of('HEAD', bucket)).toBe('HeadBucket tier2');
    expect(of('POST', bucket, 'delete&x-id=DeleteObjects')).toBe('DeleteObjects free writes');
  });

  it("an object's: put, copy, get, head, delete, and a multipart upload's every step", () => {
    expect(of('PUT', object, 'x-id=PutObject')).toBe('PutObject tier1 writes');
    expect(of('PUT', object, '', { 'x-amz-copy-source': '/photos/b.jpg' })).toBe('CopyObject tier1 writes');
    expect(of('GET', object, 'response-content-type=image%2Fjpeg&x-id=GetObject')).toBe('GetObject tier2');
    expect(of('HEAD', object)).toBe('HeadObject tier2');
    expect(of('DELETE', object)).toBe('DeleteObject free writes');
    expect(of('POST', object, 'uploads')).toBe('CreateMultipartUpload tier1 writes');
    expect(of('PUT', object, 'partNumber=1&uploadId=u1')).toBe('UploadPart tier1 writes');
    expect(of('PUT', object, 'partNumber=2&uploadId=u1', { 'x-amz-copy-source': '/photos/b.jpg' })).toBe('UploadPartCopy tier1 writes');
    expect(of('GET', object, 'uploadId=u1&max-parts=10')).toBe('ListParts tier1');
    expect(of('POST', object, 'uploadId=u1')).toBe('CompleteMultipartUpload tier1 writes');
    expect(of('DELETE', object, 'uploadId=u1')).toBe('AbortMultipartUpload free writes');
  });

  it("a presigned URL's parameters, as the SDK for JavaScript's presigner writes them, are no operation's", () => {
    // Its GET asks for the object's checksum, its PUT signs the CRC-32 of nothing, and both name their payload.
    const presigned = 'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=c&X-Amz-Date=d&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=s';
    expect(of('PUT', object, `${presigned}&x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32&x-id=PutObject`)).toBe('PutObject tier1 writes');
    expect(of('GET', object, `${presigned}&x-amz-checksum-mode=ENABLED&x-id=GetObject`)).toBe('GetObject tier2');
  });

  it("anything else answers NotImplemented: a bucket's policy or creation, an object's tags, versions", () => {
    for (const [method, address, query] of [
      ['GET', bucket, 'policy'],
      ['PUT', bucket, 'policy'],
      ['PUT', bucket, ''],
      ['DELETE', bucket, ''],
      ['GET', bucket, 'versions'],
      ['GET', bucket, 'list-type=2&acl'],
      ['GET', object, 'tagging'],
      ['PUT', object, 'tagging'],
      ['GET', object, 'versionId=3'],
      ['PUT', object, 'partNumber=1'],
      ['POST', object, 'restore'],
      ['PATCH', object, ''],
      ['PUT', { ...bucket, bucket: '' }, ''],
    ] as const) {
      expect(`${method} ${query}: ${of(method, address, query)}`).toBe(`${method} ${query}: NotImplemented tier2`);
    }
  });
});

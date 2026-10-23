import { S3Error } from './s3-error';
import {
  EMPTY_SHA256,
  RequestSignature,
  SignedRequest,
  canonicalQuery,
  canonicalUri,
  checkSignature,
  readSignature,
  signedForStore,
  uriEncode,
} from './sigv4';

// AWS's documented examples of Signature Version 4 for S3 (the S3 API reference, "Examples: Signature
// Calculations"), made with this key and secret on 2013-05-24 at midnight, UTC, for the bucket examplebucket.
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const SIGNED_AT = new Date('2013-05-24T00:00:00Z');
const HOST = 'examplebucket.s3.amazonaws.com';

/** A header-signed request as a client would send it, and its signature as the front door reads it. */
function signed(method: string, target: string, headers: Array<[string, string]>, signature: string): { request: SignedRequest; read: RequestSignature } {
  const names = headers.map(([name]) => name.toLowerCase()).sort();
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request,SignedHeaders=${names.join(';')},Signature=${signature}`;
  const all: Array<[string, string]> = [...headers, ['Authorization', authorization]];
  const [rawPath, rawQuery = ''] = target.split('?');
  const read = readSignature(Object.fromEntries(all.map(([name, value]) => [name.toLowerCase(), value])), new URLSearchParams(rawQuery));
  return { request: { method, rawPath, rawQuery, rawHeaders: all.flat() }, read: read as RequestSignature };
}

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof S3Error) return `${error.status} ${error.code}`;
    throw error;
  }
  return 'accepted';
};

describe("Signature Version 4, checked with AWS's own examples", () => {
  it('GET Object: a range, the empty body signed', () => {
    const { request, read } = signed(
      'GET',
      '/test.txt',
      [
        ['Host', HOST],
        ['Range', 'bytes=0-9'],
        ['x-amz-content-sha256', EMPTY_SHA256],
        ['x-amz-date', '20130524T000000Z'],
      ],
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );

    const chain = checkSignature(request, read, SECRET, SIGNED_AT);

    expect(chain).toMatchObject({ scope: '20130524/us-east-1/s3/aws4_request', amzDate: '20130524T000000Z', seed: read.signature });
  });

  it('PUT Object: a "$" in the key, which the canonical path encodes, and the Date header signed', () => {
    const { request, read } = signed(
      'PUT',
      '/test$file.text',
      [
        ['Host', HOST],
        ['Date', 'Fri, 24 May 2013 00:00:00 GMT'],
        ['x-amz-date', '20130524T000000Z'],
        ['x-amz-storage-class', 'REDUCED_REDUNDANCY'],
        ['x-amz-content-sha256', '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'],
      ],
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );

    expect(refusal(() => checkSignature(request, read, SECRET, SIGNED_AT))).toBe('accepted');
  });

  it('GET Bucket lifecycle: a query parameter without a value', () => {
    const { request, read } = signed(
      'GET',
      '/?lifecycle',
      [
        ['Host', HOST],
        ['x-amz-date', '20130524T000000Z'],
        ['x-amz-content-sha256', EMPTY_SHA256],
      ],
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );

    expect(refusal(() => checkSignature(request, read, SECRET, SIGNED_AT))).toBe('accepted');
  });

  it('GET Bucket, its objects listed: two parameters, sorted', () => {
    const { request, read } = signed(
      'GET',
      '/?max-keys=2&prefix=J',
      [
        ['Host', HOST],
        ['x-amz-date', '20130524T000000Z'],
        ['x-amz-content-sha256', EMPTY_SHA256],
      ],
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );

    expect(refusal(() => checkSignature(request, read, SECRET, SIGNED_AT))).toBe('accepted');
  });

  it('a presigned GET, for a day: good until it expires, refused after', () => {
    const query =
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z' +
      '&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';
    const request: SignedRequest = { method: 'GET', rawPath: '/test.txt', rawQuery: query, rawHeaders: ['Host', HOST] };
    const read = readSignature({ host: HOST }, new URLSearchParams(query)) as RequestSignature;

    expect(read).toMatchObject({ kind: 'presigned', accessKeyId: ACCESS_KEY, region: 'us-east-1', expires: 86400, payload: 'UNSIGNED-PAYLOAD' });
    expect(refusal(() => checkSignature(request, read, SECRET, new Date('2013-05-24T23:59:59Z')))).toBe('accepted');
    expect(refusal(() => checkSignature(request, read, SECRET, new Date('2013-05-25T00:00:01Z')))).toBe('403 AccessDenied');
    expect(refusal(() => checkSignature(request, read, SECRET, new Date('2013-05-23T23:00:00Z')))).toBe('403 AccessDenied');
  });
});

describe('Signature Version 4: what is refused', () => {
  const getObject = () =>
    signed(
      'GET',
      '/test.txt',
      [
        ['Host', HOST],
        ['Range', 'bytes=0-9'],
        ['x-amz-content-sha256', EMPTY_SHA256],
        ['x-amz-date', '20130524T000000Z'],
      ],
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );

  it('another secret, a header changed, the path changed: the signature does not match', () => {
    const { request, read } = getObject();

    expect(refusal(() => checkSignature(request, read, `${SECRET}x`, SIGNED_AT))).toBe('403 SignatureDoesNotMatch');
    const ranged = { ...request, rawHeaders: request.rawHeaders.map((value) => (value === 'bytes=0-9' ? 'bytes=0-99' : value)) };
    expect(refusal(() => checkSignature(ranged, read, SECRET, SIGNED_AT))).toBe('403 SignatureDoesNotMatch');
    expect(refusal(() => checkSignature({ ...request, rawPath: '/test.txu' }, read, SECRET, SIGNED_AT))).toBe('403 SignatureDoesNotMatch');
  });

  it('a request signed more than 15 minutes from now, either way', () => {
    const { request, read } = getObject();

    expect(refusal(() => checkSignature(request, read, SECRET, new Date('2013-05-24T00:15:00Z')))).toBe('accepted');
    expect(refusal(() => checkSignature(request, read, SECRET, new Date('2013-05-24T00:15:01Z')))).toBe('403 RequestTimeTooSkewed');
    expect(refusal(() => checkSignature(request, read, SECRET, new Date('2013-05-23T23:44:59Z')))).toBe('403 RequestTimeTooSkewed');
  });

  it("a signature that doesn't sign the host, or the body's hash", () => {
    const { request, read } = getObject();

    expect(refusal(() => checkSignature(request, { ...read, signedHeaders: ['range', 'x-amz-content-sha256', 'x-amz-date'] }, SECRET, SIGNED_AT))).toBe(
      '400 AuthorizationHeaderMalformed',
    );
    expect(refusal(() => checkSignature(request, { ...read, signedHeaders: ['host', 'range', 'x-amz-date'] }, SECRET, SIGNED_AT))).toBe(
      '400 AuthorizationHeaderMalformed',
    );
  });

  it("what isn't Signature Version 4, or is malformed, before any secret is looked for", () => {
    const query = new URLSearchParams();
    const credential = `${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request`;
    const header = (authorization: string, extra: Record<string, string> = {}) => () =>
      readSignature({ authorization, 'x-amz-date': '20130524T000000Z', 'x-amz-content-sha256': EMPTY_SHA256, ...extra }, query);

    expect(readSignature({ host: HOST }, query)).toBeNull();
    expect(refusal(header('AWS AKIAIOSFODNN7EXAMPLE:frJIUN8DYpKDtOLCwo//yllqDzg='))).toBe('400 InvalidRequest');
    expect(refusal(header(`AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=host`))).toBe('400 AuthorizationHeaderMalformed');
    expect(refusal(header(`AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20130524/us-east-1/s4/aws4_request,SignedHeaders=host,Signature=00`))).toBe(
      '400 AuthorizationHeaderMalformed',
    );
    expect(refusal(header(`AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=host,Signature=00`, { 'x-amz-security-token': 'token' }))).toBe('400 InvalidToken');
    expect(refusal(() => readSignature({ authorization: `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=host,Signature=00`, 'x-amz-date': '20130524T000000Z' }, query))).toBe(
      '400 InvalidRequest',
    );
    const both = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256' });
    expect(refusal(() => readSignature({ authorization: `AWS4-HMAC-SHA256 Credential=${credential},SignedHeaders=host,Signature=00` }, both))).toBe('400 InvalidArgument');
  });

  it("a presigned URL without its parameters, or for longer than a week", () => {
    const presigned = (parameters: Record<string, string>) => () =>
      readSignature(
        { host: HOST },
        new URLSearchParams({
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Credential': `${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request`,
          'X-Amz-Date': '20130524T000000Z',
          'X-Amz-Expires': '86400',
          'X-Amz-SignedHeaders': 'host',
          'X-Amz-Signature': '00',
          ...parameters,
        }),
      );

    expect(refusal(presigned({}))).toBe('accepted');
    expect(refusal(presigned({ 'X-Amz-Signature': '' }))).toBe('400 AuthorizationQueryParametersError');
    expect(refusal(presigned({ 'X-Amz-Expires': '604801' }))).toBe('400 AuthorizationQueryParametersError');
    expect(refusal(presigned({ 'X-Amz-Expires': '0' }))).toBe('400 AuthorizationQueryParametersError');
    expect(refusal(presigned({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA1' }))).toBe('400 AuthorizationQueryParametersError');
  });
});

describe('the canonical request', () => {
  it('encodes each path segment once, as the client meant it, and normalizes nothing', () => {
    expect(canonicalUri('/photos/2026/a b.jpg')).toBe('/photos/2026/a%20b.jpg');
    expect(canonicalUri('/photos//a%2ab')).toBe('/photos//a%2Ab');
    expect(canonicalUri('/photos/./../x')).toBe('/photos/./../x');
    expect(canonicalUri('/k%C3%A9y%2Fslash')).toBe('/k%C3%A9y%2Fslash');
    expect(canonicalUri('')).toBe('/');
    expect(uriEncode('a/b~c', true)).toBe('a/b~c');
  });

  it('sorts the query by name, then by value, each encoded; "+" is a plus sign, as Signature Version 4 reads it', () => {
    expect(canonicalQuery('prefix=J&max-keys=2&list-type=2')).toBe('list-type=2&max-keys=2&prefix=J');
    expect(canonicalQuery('a=2&a=1&b')).toBe('a=1&a=2&b=');
    expect(canonicalQuery('prefix=a+b&delimiter=%2F')).toBe('delimiter=%2F&prefix=a%2Bb');
    expect(canonicalQuery('X-Amz-Signature=00&X-Amz-Date=1', 'X-Amz-Signature')).toBe('X-Amz-Date=1');
  });
});

describe("FF's own requests to the store", () => {
  it('sign every header given and an unsigned body, in a form the store checks as any client', () => {
    const at = new Date('2026-10-23T06:00:00Z');
    const headers = signedForStore(
      { method: 'PUT', host: 'store:8333', rawPath: '/ff-0123/photos/a%20b.jpg', rawQuery: 'uploadId=7&partNumber=1', headers: { 'Content-Length': '5', 'content-type': 'image/jpeg' } },
      { accessKeyId: 'STOREKEY', secretAccessKey: 'store-secret', region: 'us-east-1' },
      at,
    );

    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=STOREKEY\/20261023\/us-east-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // The store checks it as the front door checks a client's.
    const request: SignedRequest = { method: 'PUT', rawPath: '/ff-0123/photos/a%20b.jpg', rawQuery: 'uploadId=7&partNumber=1', rawHeaders: Object.entries(headers).flat() };
    const read = readSignature(headers, new URLSearchParams(request.rawQuery)) as RequestSignature;
    expect(refusal(() => checkSignature(request, read, 'store-secret', at))).toBe('accepted');
  });
});

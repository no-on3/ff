import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignedRequest } from '../common/signature-v4';
import { S3Error } from './s3-error';
import { RequestSignature, checkSignature, readSignature, signedForStore } from './s3-signature';

interface Example {
  title: string;
  method: string;
  /** The path, and the query after its "?". */
  target: string;
  /** In order, as sent. */
  headers: Array<[string, string]>;
  signature: string;
  scope?: string;
}

/** An example changed: by its secret, its time, a header's value, its path, or the headers its signature names. */
interface Changed {
  title: string;
  example: string;
  secret?: string;
  at?: string;
  header?: [string, string];
  target?: string;
  signedHeaders?: string[];
  answer: string;
}

/** Headers, and a query, read for a signature before any secret is looked for. */
interface ReadCase {
  title: string;
  headers: Record<string, string>;
  query?: Record<string, string>;
  answer: string;
}

// AWS's documented examples of Signature Version 4 for S3 (the S3 API reference, "Examples: Signature Calculations"),
// made with the table's key and secret on 2013-05-24 at midnight, UTC, for the bucket examplebucket; ff local's S3 reads
// them too.
const { signatures } = JSON.parse(readFileSync(join(__dirname, 's3-examples.json'), 'utf8')) as {
  signatures: {
    key: string;
    secret: string;
    at: string;
    host: string;
    examples: Record<string, Example>;
    presignedGet: { method: string; target: string; headers: Array<[string, string]>; read: Partial<RequestSignature>; answers: Array<{ at: string; answer: string }> };
    changed: Record<string, Changed[]>;
    read: Record<string, ReadCase[]>;
  };
};
const SECRET = signatures.secret;
const SIGNED_AT = new Date(signatures.at);

/** A header-signed request as a client would send it, and its signature as the front door reads it. */
function signed({ method, target, headers, signature }: Example): { request: SignedRequest; read: RequestSignature } {
  const names = headers.map(([name]) => name.toLowerCase()).sort();
  const authorization = `AWS4-HMAC-SHA256 Credential=${signatures.key}/20130524/us-east-1/s3/aws4_request,SignedHeaders=${names.join(';')},Signature=${signature}`;
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

/** The example, signed, checked against the table's secret at its time. */
const checked = (name: string) => {
  const { request, read } = signed(signatures.examples[name]);
  return refusal(() => checkSignature(request, read, SECRET, SIGNED_AT));
};

/** Each case of the group: its example changed as it says, checked. */
function changedAnswers(group: string): void {
  const cases = signatures.changed[group];
  expect(cases.length).toBeGreaterThan(0);
  for (const { title, example, secret = SECRET, at = signatures.at, header, target, signedHeaders, answer } of cases) {
    const { request, read } = signed(signatures.examples[example]);
    const values = header ? request.rawHeaders.map((value, i) => (i % 2 === 1 && request.rawHeaders[i - 1] === header[0] ? header[1] : value)) : request.rawHeaders;
    const changed: SignedRequest = { ...request, rawHeaders: values, ...(target ? { rawPath: target } : {}) };
    const readAs = signedHeaders ? { ...read, signedHeaders } : read;
    expect(`${title}: ${refusal(() => checkSignature(changed, readAs, secret, new Date(at)))}`).toBe(`${title}: ${answer}`);
  }
}

/** Each case of the group, read: no signature, one read, or its refusal. */
function readAnswers(group: string): void {
  const cases = signatures.read[group];
  expect(cases.length).toBeGreaterThan(0);
  for (const { title, headers, query = {}, answer } of cases) {
    let read: RequestSignature | null = null;
    const outcome = refusal(() => (read = readSignature(headers, new URLSearchParams(query))));
    expect(`${title}: ${outcome === 'accepted' && read === null ? 'none' : outcome}`).toBe(`${title}: ${answer}`);
  }
}

describe("Signature Version 4, checked with AWS's own examples", () => {
  it('GET Object: a range, the empty body signed', () => {
    const example = signatures.examples.getObject;
    const { request, read } = signed(example);

    const chain = checkSignature(request, read, SECRET, SIGNED_AT);

    expect(chain).toMatchObject({ scope: example.scope, amzDate: '20130524T000000Z', seed: read.signature });
  });

  it('PUT Object: a "$" in the key, which the canonical path encodes, and the Date header signed', () => {
    expect(checked('putObject')).toBe('accepted');
  });

  it('GET Bucket lifecycle: a query parameter without a value', () => {
    expect(checked('lifecycle')).toBe('accepted');
  });

  it('GET Bucket, its objects listed: two parameters, sorted', () => {
    expect(checked('listObjects')).toBe('accepted');
  });

  it('a presigned GET, for a day: good until it expires, refused after', () => {
    const { method, target, headers, read: expected, answers } = signatures.presignedGet;
    const [rawPath, query] = target.split('?');
    const request: SignedRequest = { method, rawPath, rawQuery: query, rawHeaders: headers.flat() };
    const read = readSignature(Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value])), new URLSearchParams(query)) as RequestSignature;

    expect(read).toMatchObject(expected);
    expect(answers.map(({ at }) => refusal(() => checkSignature(request, read, SECRET, new Date(at))))).toEqual(answers.map(({ answer }) => answer));
  });
});

describe('Signature Version 4: what is refused', () => {
  it('another secret, a header changed, the path changed: the signature does not match', () => changedAnswers('mismatched'));

  it('a request signed more than 15 minutes from now, either way', () => changedAnswers('skewed'));

  it("a signature that doesn't sign the host, or the body's hash", () => changedAnswers('unsigned'));

  it("what isn't Signature Version 4, or is malformed, before any secret is looked for", () => readAnswers('malformed'));

  it('a presigned URL without its parameters, or for longer than a week', () => readAnswers('presigned'));
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

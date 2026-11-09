import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3Address, addressOf, operationOf } from './s3-requests';

interface AddressCase {
  host: string;
  path: string;
  address: S3Address;
}

interface OperationCase {
  method: string;
  on: 'service' | 'bucket' | 'object';
  query: string;
  headers?: Record<string, string>;
  /** S3's name, its class, and "writes" for an operation a read-only key may not make. */
  is: string;
}

/** The table ff local's S3 reads too: requests' addresses, and the operations they are. */
const table = JSON.parse(readFileSync(join(__dirname, 's3-examples.json'), 'utf8')) as {
  host: string;
  addresses: Record<string, AddressCase[]>;
  operations: Record<string, OperationCase[]>;
};

/** Each case of the table's group, as the front door reads it. */
function addressesOf(group: string): void {
  const cases = table.addresses[group];
  expect(cases.length).toBeGreaterThan(0);
  for (const { host, path, address } of cases) expect([host, path, addressOf(host, path, table.host)]).toEqual([host, path, address]);
}

/** The bucket `photos`, path-style: the service itself, the bucket, or its object `a.jpg`. */
const ADDRESSES: Record<OperationCase['on'], S3Address> = {
  service: { style: 'path', bucket: '', rawKey: '' },
  bucket: { style: 'path', bucket: 'photos', rawKey: '' },
  object: { style: 'path', bucket: 'photos', rawKey: 'a.jpg' },
};

function operationsOf(group: string): void {
  const cases = table.operations[group];
  expect(cases.length).toBeGreaterThan(0);
  for (const { method, on, query, headers = {}, is } of cases) {
    const operation = operationOf(method, ADDRESSES[on], new URLSearchParams(query), headers);
    expect(`${method} ${on} ${query}: ${operation.name} ${operation.class}${operation.writes ? ' writes' : ''}`).toBe(`${method} ${on} ${query}: ${is}`);
  }
}

describe("a request's bucket and key", () => {
  it('virtual-hosted, as the SDK for JavaScript addresses a host name', () => addressesOf('virtualHosted'));

  it('path-style, as boto3 and the CLI address any endpoint and every SDK an IP address', () => addressesOf('pathStyle'));

  it("a host two labels deeper is no bucket of FF's: path-style, so its path names the bucket", () => addressesOf('deeperHost'));
});

describe('the operation a request is', () => {
  it('a bucket made, as S3 bills a PUT, and deleted for free, as a DELETE; with a parameter, another operation', () => operationsOf('bucketMadeAndDeleted'));

  it("the bucket's tags: read as a GET, replaced as a PUT, removed for free, as a DELETE", () => operationsOf('tags'));

  it("the bucket's policy and public access block, kept as the tags are: read as a GET, set as a PUT, removed for free; with the object's key, NotImplemented", () =>
    operationsOf('policyAndPublicAccessBlock'));

  it("the bucket's settings FF's buckets don't have, each read as a GET, which S3 answers for a bucket without it; set, NotImplemented", () => operationsOf('unsetSettings'));

  it("the bucket's: listings, its location, the bucket itself, a batch of deletes", () => operationsOf('bucketReads'));

  it("the bucket's website configuration: set and read as S3 bills a PUT and a GET, removed for free, as a DELETE", () => operationsOf('website'));

  it("an object's: put, copy, get, head, delete, and a multipart upload's every step", () => operationsOf('objects'));

  // Its GET asks for the object's checksum, its PUT signs the CRC-32 of nothing, and both name their payload.
  it("a presigned URL's parameters, as the SDK for JavaScript's presigner writes them, are no operation's", () => operationsOf('presigned'));

  it("anything else answers NotImplemented: a bucket's CORS set, its policy's status, an object's tags, versions", () => operationsOf('notImplemented'));
});

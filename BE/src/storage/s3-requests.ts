import { IncomingHttpHeaders } from 'node:http';
import { decodeEscapes } from './sigv4';

/** A request's bucket and key: by its host (virtual-hosted) or its path's first segment (path-style). */
export interface S3Address {
  style: 'virtual-hosted' | 'path';
  /** The bucket's name; empty for a request to the service itself, such as ListBuckets. */
  bucket: string;
  /** The key as the client sent it in the path, still encoded; empty for the bucket itself. */
  rawKey: string;
}

/**
 * The bucket and key a request names. `<bucket>.<host>` is virtual-hosted;
 * anything else is path-style, `<host>/<bucket>/<key>`, as AWS's SDKs address
 * an IP address, and boto3 and the CLI any endpoint. Bucket names have no dots,
 * so a host with one more label than FF's is a bucket's.
 */
export function addressOf(host: string | undefined, rawPath: string, storageHost: string): S3Address {
  const name = (host ?? '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
  const suffix = `.${storageHost}`;
  if (name.endsWith(suffix) && !name.slice(0, -suffix.length).includes('.')) {
    return { style: 'virtual-hosted', bucket: name.slice(0, -suffix.length), rawKey: rawPath.replace(/^\//, '') };
  }
  const [, bucket = '', ...rest] = rawPath.split('/');
  return { style: 'path', bucket: decodeEscapes(bucket), rawKey: rest.join('/') };
}

/** How AWS bills a request: its first class (PUT, COPY, POST, LIST), its second (GET, HEAD and the rest), or free (DELETE, an upload aborted). */
export type RequestClass = 'tier1' | 'tier2' | 'free';

/** An operation the front door serves, as S3 names it. */
export interface S3Operation {
  name: string;
  class: RequestClass;
  /** Whether it changes the bucket: a read-only key may not. */
  writes: boolean;
}

/** Query parameters every request may carry: the signature's, the checksum's a presigned URL signs, and the "x-id" AWS's SDKs add. */
const ALWAYS = /^(X-Amz-[A-Za-z-]+|x-amz-checksum-[a-z0-9]+|x-amz-sdk-checksum-algorithm|x-id)$/;
const LISTING = new Set(['list-type', 'prefix', 'delimiter', 'max-keys', 'marker', 'continuation-token', 'start-after', 'encoding-type', 'fetch-owner']);
const UPLOADS_LISTING = new Set(['uploads', 'prefix', 'delimiter', 'max-uploads', 'key-marker', 'upload-id-marker', 'encoding-type']);
const PARTS_LISTING = new Set(['uploadId', 'max-parts', 'part-number-marker', 'encoding-type']);
const GET_OBJECT = new Set([
  'partNumber',
  'response-content-type',
  'response-content-language',
  'response-expires',
  'response-cache-control',
  'response-content-disposition',
  'response-content-encoding',
]);

const op = (name: string, klass: RequestClass, writes = false): S3Operation => ({ name, class: klass, writes });
const NOT_IMPLEMENTED = op('NotImplemented', 'tier2');

/**
 * The operation a request is, from its method, its address and its query, as
 * S3 tells them apart; anything else, a bucket's policy or an object's tags
 * among them, is NotImplemented. Its parameters must all be the operation's.
 */
export function operationOf(method: string, address: S3Address, query: URLSearchParams, headers: IncomingHttpHeaders): S3Operation {
  const names = [...new Set(query.keys())].filter((name) => !ALWAYS.test(name));
  const only = (...allowed: Array<Set<string> | string>) =>
    names.every((name) => allowed.some((set) => (typeof set === 'string' ? set === name : set.has(name))));
  const has = (name: string) => names.includes(name);
  const copySource = headers['x-amz-copy-source'] !== undefined;

  if (!address.bucket) return method === 'GET' && names.length === 0 ? op('ListBuckets', 'tier1') : NOT_IMPLEMENTED;
  if (!address.rawKey) {
    if (method === 'GET' && has('location') && only('location')) return op('GetBucketLocation', 'tier2');
    if (method === 'GET' && has('uploads') && only(UPLOADS_LISTING)) return op('ListMultipartUploads', 'tier1');
    if (method === 'GET' && only(LISTING)) return op(query.get('list-type') === '2' ? 'ListObjectsV2' : 'ListObjects', 'tier1');
    if (method === 'HEAD' && names.length === 0) return op('HeadBucket', 'tier2');
    if (method === 'POST' && has('delete') && only('delete')) return op('DeleteObjects', 'free', true);
    return NOT_IMPLEMENTED;
  }
  switch (method) {
    case 'PUT':
      if (has('partNumber') || has('uploadId')) return only('partNumber', 'uploadId') && has('partNumber') && has('uploadId') ? op(copySource ? 'UploadPartCopy' : 'UploadPart', 'tier1', true) : NOT_IMPLEMENTED;
      return names.length === 0 ? op(copySource ? 'CopyObject' : 'PutObject', 'tier1', true) : NOT_IMPLEMENTED;
    case 'POST':
      if (has('uploads') && only('uploads')) return op('CreateMultipartUpload', 'tier1', true);
      if (has('uploadId') && only('uploadId')) return op('CompleteMultipartUpload', 'tier1', true);
      return NOT_IMPLEMENTED;
    case 'GET':
      if (has('uploadId')) return only(PARTS_LISTING) ? op('ListParts', 'tier1') : NOT_IMPLEMENTED;
      return only(GET_OBJECT) ? op('GetObject', 'tier2') : NOT_IMPLEMENTED;
    case 'HEAD':
      return only('partNumber') ? op('HeadObject', 'tier2') : NOT_IMPLEMENTED;
    case 'DELETE':
      if (has('uploadId')) return only('uploadId') ? op('AbortMultipartUpload', 'free', true) : NOT_IMPLEMENTED;
      return names.length === 0 ? op('DeleteObject', 'free', true) : NOT_IMPLEMENTED;
    default:
      return NOT_IMPLEMENTED;
  }
}

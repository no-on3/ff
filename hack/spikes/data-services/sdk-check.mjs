#!/usr/bin/env node
// AWS's SDK for JavaScript v3 against the spike's S3 front door, with its defaults, as a customer's code has them:
// only the endpoint, the region and the key are given. Prints one JSON line per check.
//   MODULES=<folder with node_modules> ENDPOINT=http://s3.localhost:55480 KEY=… SECRET=… BUCKET=photos \
//   OTHER_BUCKET=other WRONG_SECRET=… node sdk-check.mjs
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(`${process.env.MODULES}/`);
const s3 = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const { ENDPOINT, KEY, SECRET, BUCKET, OTHER_BUCKET, IP_ENDPOINT } = process.env;
const region = 'tn-tunis-1';
const credentials = { accessKeyId: KEY, secretAccessKey: SECRET };
const client = (options = {}) => new s3.S3Client({ endpoint: ENDPOINT, region, credentials, ...options });
const virtual = client();
const path = client({ forcePathStyle: true });
const byIp = new s3.S3Client({ endpoint: IP_ENDPOINT, region, credentials });

async function check(want, what, run) {
  let got = 'ok';
  let detail = '';
  try {
    detail = String((await run()) ?? '');
  } catch (error) {
    got = 'refused';
    detail = `${error.name}: ${error.message}`.slice(0, 160);
  }
  console.log(JSON.stringify({ client: 'sdk-js', want, got, what, detail }));
}
const text = async (body) => Buffer.from(await body.transformToByteArray()).toString('utf8');
const MB = 1024 * 1024;

await check('ok', 'PutObject, a string body (virtual-hosted, the default for a host name)', () =>
  virtual.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'hello.txt', Body: 'hello from the SDK', ContentType: 'text/plain' })).then((r) => r.ETag));
await check('ok', 'PutObject, a key with spaces and unicode', () => virtual.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'dir/a b+c (é).txt', Body: 'odd key' })).then((r) => r.ETag));
await check('ok', 'GetObject, the same key back', async () => text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'dir/a b+c (é).txt' }))).Body));
await check('ok', 'PutObject, a stream of known length (ContentLength given)', () =>
  virtual.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'stream.bin', Body: Readable.from([Buffer.alloc(3 * MB, 7)]), ContentLength: 3 * MB })).then((r) => r.ETag));
await check('ok', 'PutObject, a 5 MB Buffer', () => virtual.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'buffer.bin', Body: Buffer.alloc(5 * MB, 1) })).then((r) => r.ETag));
await check('ok', 'GetObject', async () => text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }))).Body));
await check('ok', 'GetObject with a Range', async () => text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt', Range: 'bytes=0-4' }))).Body));
await check('ok', 'HeadObject', async () => (await virtual.send(new s3.HeadObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }))).ContentLength);
await check('ok', 'PutObject and GetObject, path-style (forcePathStyle)', async () => {
  await path.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'path.txt', Body: 'path-style' }));
  return text((await path.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'path.txt' }))).Body);
});
await check('ok', 'an IP address for the endpoint, no forcePathStyle: the SDK goes path-style itself', async () => {
  await byIp.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'ip.txt', Body: 'by IP' }));
  return text((await byIp.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'ip.txt' }))).Body);
});
await check('ok', 'ListObjectsV2, a page of 2, then the next', async () => {
  const first = await virtual.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2 }));
  const next = await virtual.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 2, ContinuationToken: first.NextContinuationToken }));
  return `${first.Name}: ${first.Contents.map((o) => o.Key).join(', ')} | ${next.Contents.map((o) => o.Key).join(', ')}`;
});
await check('ok', 'ListObjectsV2 with a prefix and a delimiter', async () => {
  const page = await virtual.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'dir/', Delimiter: '/' }));
  return (page.Contents ?? []).map((o) => o.Key).join(', ');
});
await check('ok', 'CopyObject', () => virtual.send(new s3.CopyObjectCommand({ Bucket: BUCKET, Key: 'copy.txt', CopySource: `${BUCKET}/hello.txt` })).then((r) => r.CopyObjectResult?.ETag));
await check('refused', 'CopyObject from a bucket the key may not reach', () => virtual.send(new s3.CopyObjectCommand({ Bucket: BUCKET, Key: 'stolen.txt', CopySource: `${OTHER_BUCKET}/secret.txt` })));
await check('ok', 'multipart with lib-storage: 22 MB in 5 MB parts', async () => {
  const upload = new Upload({ client: virtual, params: { Bucket: BUCKET, Key: 'big.bin', Body: Readable.from([Buffer.alloc(22 * MB, 3)]) }, partSize: 5 * MB, queueSize: 2 });
  const done = await upload.done();
  const head = await virtual.send(new s3.HeadObjectCommand({ Bucket: BUCKET, Key: 'big.bin' }));
  return `${done.ETag} ${head.ContentLength} bytes`;
});
await check('ok', 'multipart by hand: Create, UploadPart, ListParts, Abort', async () => {
  const { UploadId } = await virtual.send(new s3.CreateMultipartUploadCommand({ Bucket: BUCKET, Key: 'aborted.bin' }));
  await virtual.send(new s3.UploadPartCommand({ Bucket: BUCKET, Key: 'aborted.bin', UploadId, PartNumber: 1, Body: Buffer.alloc(5 * MB, 9) }));
  const parts = await virtual.send(new s3.ListPartsCommand({ Bucket: BUCKET, Key: 'aborted.bin', UploadId }));
  await virtual.send(new s3.AbortMultipartUploadCommand({ Bucket: BUCKET, Key: 'aborted.bin', UploadId }));
  return `${parts.Parts?.length} part listed, then aborted`;
});
await check('ok', 'a presigned GET URL, fetched', async () => {
  const url = await getSignedUrl(virtual, new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }), { expiresIn: 300 });
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  return answer.text();
});
await check('ok', 'a presigned PUT URL, a browser-like upload', async () => {
  const url = await getSignedUrl(virtual, new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt', ContentType: 'text/plain' }), { expiresIn: 300 });
  const answer = await fetch(url, { method: 'PUT', body: 'uploaded with a presigned URL', headers: { 'content-type': 'text/plain' } });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}: ${await answer.text()}`);
  return text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt' }))).Body);
});
await check('refused', 'a presigned URL past its expiry', async () => {
  const url = await getSignedUrl(virtual, new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }), { expiresIn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`HTTP ${answer.status}: ${(await answer.text()).match(/<Code>([^<]+)/)?.[1]}`);
});
await check('refused', 'a presigned URL whose key was changed', async () => {
  const url = await getSignedUrl(virtual, new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }), { expiresIn: 300 });
  const answer = await fetch(url.replace('hello.txt', 'copy.txt'));
  if (!answer.ok) throw new Error(`HTTP ${answer.status}: ${(await answer.text()).match(/<Code>([^<]+)/)?.[1]}`);
});
await check('refused', 'a wrong secret', () =>
  new s3.S3Client({ endpoint: ENDPOINT, region, credentials: { accessKeyId: KEY, secretAccessKey: `${SECRET}x` } }).send(new s3.HeadObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' })));
await check('refused', 'a bucket the key may not reach', () => virtual.send(new s3.GetObjectCommand({ Bucket: OTHER_BUCKET, Key: 'secret.txt' })));
await check('ok', 'ListBuckets: the key’s own', async () => (await virtual.send(new s3.ListBucketsCommand({}))).Buckets.map((b) => b.Name).join(', '));
await check('ok', 'GetBucketLocation', async () => (await virtual.send(new s3.GetBucketLocationCommand({ Bucket: BUCKET }))).LocationConstraint);
await check('ok', 'HeadBucket', () => virtual.send(new s3.HeadBucketCommand({ Bucket: BUCKET })).then(() => 'exists'));
await check('ok', 'DeleteObjects, two keys', async () => (await virtual.send(new s3.DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: 'copy.txt' }, { Key: 'path.txt' }] } }))).Deleted?.length);
await check('ok', 'DeleteObject', () => virtual.send(new s3.DeleteObjectCommand({ Bucket: BUCKET, Key: 'ip.txt' })).then(() => 'deleted'));
await check('refused', 'GetObject of a key that was deleted (NoSuchKey)', () => virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'ip.txt' })));
await check('refused', 'an operation the front door doesn’t serve: PutBucketPolicy', () =>
  virtual.send(new s3.PutBucketPolicyCommand({ Bucket: BUCKET, Policy: '{"Version":"2012-10-17","Statement":[]}' })));

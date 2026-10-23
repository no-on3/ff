#!/usr/bin/env node
// AWS's SDK for JavaScript v3 against FF's S3 front door, with its defaults, as a customer's code has them: only the
// endpoint, the region and the key are given. One JSON line per check, {client, want, got, what}, for hack/e2e.sh.
//   MODULES=<folder with node_modules> ENDPOINT=http://s3.localhost:<port> IP_ENDPOINT=http://127.0.0.1:<port> \
//   KEY=… SECRET=… BUCKET=… OTHER_BUCKET=… BIG=<a file of 100 MB> node sdk.mjs
import { createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(`${process.env.MODULES}/`);
const s3 = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const { ENDPOINT, IP_ENDPOINT, KEY, SECRET, BUCKET, OTHER_BUCKET, BIG } = process.env;
const region = 'tn-tunis-1';
const credentials = { accessKeyId: KEY, secretAccessKey: SECRET };
// A host name: the SDK addresses it virtual-hosted, <bucket>.s3.localhost; an IP address, path-style, by itself.
const virtual = new s3.S3Client({ endpoint: ENDPOINT, region, credentials });
const byIp = new s3.S3Client({ endpoint: IP_ENDPOINT, region, credentials });
const MB = 1024 * 1024;

async function check(want, what, run) {
  let got = 'ok';
  let detail = '';
  try {
    detail = String((await run()) ?? '');
  } catch (error) {
    got = 'refused';
    detail = `${error.name}: ${error.message}`;
  }
  console.log(JSON.stringify({ client: 'sdk', want, got, what, detail: detail.slice(0, 200) }));
}
const text = async (body) => Buffer.from(await body.transformToByteArray()).toString('utf8');
/** Fails unless the answer is what it should be. */
const expect = (actual, wanted) => {
  if (actual !== wanted) throw new Error(`got ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
  return actual;
};

await check('ok', 'uploads a string, virtual-hosted, and downloads it', async () => {
  await virtual.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'hello.txt', Body: 'Ahlan from the SDK', ContentType: 'text/plain' }));
  return expect(await text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }))).Body), 'Ahlan from the SDK');
});
await check('ok', 'uploads a 5 MB stream, aws-chunked with a trailing CRC-32, its key with spaces and an accent', async () => {
  await virtual.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'dir/a b (é).bin', Body: Readable.from([Buffer.alloc(5 * MB, 7)]), ContentLength: 5 * MB }));
  return expect((await virtual.send(new s3.HeadObjectCommand({ Bucket: BUCKET, Key: 'dir/a b (é).bin' }))).ContentLength, 5 * MB);
});
await check('ok', 'downloads a range', async () => expect(await text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt', Range: 'bytes=0-4' }))).Body), 'Ahlan'));
await check('ok', 'reaches it by IP address, path-style, as a function does', async () => expect(await text((await byIp.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }))).Body), 'Ahlan from the SDK'));
await check('ok', 'lists by a prefix and a delimiter, then page by page', async () => {
  const folders = await virtual.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, Delimiter: '/' }));
  const first = await virtual.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
  const next = await virtual.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1, ContinuationToken: first.NextContinuationToken }));
  return expect(`${folders.Name} ${folders.CommonPrefixes.map((p) => p.Prefix)} ${first.Contents.length + next.Contents.length}`, `${BUCKET} dir/ 2`);
});
await check('ok', 'uploads 100 MB in parts with lib-storage, its bytes the same', async () => {
  const upload = new Upload({ client: virtual, params: { Bucket: BUCKET, Key: 'big-sdk.bin', Body: createReadStream(BIG) }, partSize: 8 * MB, queueSize: 4 });
  await upload.done();
  const got = await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'big-sdk.bin' }));
  const hash = createHash('sha256');
  for await (const chunk of got.Body) hash.update(chunk);
  const local = createHash('sha256');
  for await (const chunk of createReadStream(BIG)) local.update(chunk);
  return expect(`${got.ContentLength} ${hash.digest('hex')}`, `${statSync(BIG).size} ${local.digest('hex')}`);
});
await check('ok', 'a presigned GET, fetched', async () => {
  const url = await getSignedUrl(virtual, new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }), { expiresIn: 300 });
  return expect(await (await fetch(url)).text(), 'Ahlan from the SDK');
});
await check('ok', 'a presigned PUT, as a browser uploads, its signed CRC-32 of nothing ignored as S3 does', async () => {
  const url = await getSignedUrl(virtual, new s3.PutObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt', ContentType: 'text/plain' }), { expiresIn: 300 });
  const answer = await fetch(url, { method: 'PUT', body: 'uploaded with a presigned URL', headers: { 'content-type': 'text/plain' } });
  if (!answer.ok) throw new Error(`HTTP ${answer.status}: ${await answer.text()}`);
  return expect(await text((await virtual.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'presigned.txt' }))).Body), 'uploaded with a presigned URL');
});
await check('refused', 'a presigned URL past its expiry: AccessDenied', async () => {
  const url = await getSignedUrl(virtual, new s3.GetObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' }), { expiresIn: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`HTTP ${answer.status}: ${(await answer.text()).match(/<Code>([^<]+)/)?.[1]}`);
});
await check('refused', 'a wrong secret: SignatureDoesNotMatch', () =>
  new s3.S3Client({ endpoint: ENDPOINT, region, credentials: { accessKeyId: KEY, secretAccessKey: `${SECRET}x` } }).send(new s3.HeadObjectCommand({ Bucket: BUCKET, Key: 'hello.txt' })));
await check('refused', "another account's bucket: AccessDenied", () => virtual.send(new s3.GetObjectCommand({ Bucket: OTHER_BUCKET, Key: 'anything.txt' })));
await check('ok', 'copies, then deletes a batch and one', async () => {
  await virtual.send(new s3.CopyObjectCommand({ Bucket: BUCKET, Key: 'copy.txt', CopySource: `${BUCKET}/hello.txt` }));
  const batch = await virtual.send(new s3.DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: [{ Key: 'copy.txt' }, { Key: 'presigned.txt' }] } }));
  await virtual.send(new s3.DeleteObjectCommand({ Bucket: BUCKET, Key: 'dir/a b (é).bin' }));
  return expect(batch.Deleted.length, 2);
});
await check('ok', "ListBuckets, the account's, and the bucket's region", async () => {
  const listed = (await virtual.send(new s3.ListBucketsCommand({}))).Buckets.map((b) => b.Name);
  const location = (await virtual.send(new s3.GetBucketLocationCommand({ Bucket: BUCKET }))).LocationConstraint;
  return expect(`${listed.includes(BUCKET)} ${listed.includes(OTHER_BUCKET)} ${location}`, 'true false tn-tunis-1');
});
await check('refused', "what the front door doesn't serve: PutBucketPolicy, NotImplemented", () =>
  virtual.send(new s3.PutBucketPolicyCommand({ Bucket: BUCKET, Policy: '{"Version":"2012-10-17","Statement":[]}' })));

#!/usr/bin/env node
// AWS's SDK for JavaScript v3, with its defaults, against one side's front doors: the spike's twelve checks, the
// same as cli.sh's and boto3_checks.py's. One JSON line per check, {client, check, passed, detail}.
//   S3_MODULES=<folder with @aws-sdk/client-s3> SQS_MODULES=<… client-sqs> S3_ENDPOINT=… SQS_ENDPOINT=… ACCOUNT=… \
//   KEY=… SECRET=… BUCKET=… QUEUE=… node sdk.mjs
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const s3 = createRequire(`${process.env.S3_MODULES}/`)('@aws-sdk/client-s3');
const sqs = createRequire(`${process.env.SQS_MODULES}/`)('@aws-sdk/client-sqs');
const { S3_ENDPOINT, SQS_ENDPOINT, ACCOUNT, KEY, SECRET, BUCKET, QUEUE } = process.env;
const region = 'tn-tunis-1';
const credentials = { accessKeyId: KEY, secretAccessKey: SECRET };
const wrong = { accessKeyId: KEY, secretAccessKey: 'wrong-secret' };
const objects = new s3.S3Client({ endpoint: S3_ENDPOINT, region, credentials, forcePathStyle: true });
const queues = new sqs.SQSClient({ endpoint: SQS_ENDPOINT, region, credentials });
const prefix = 'sdk/';
const MB = 1024 * 1024;

async function check(name, run) {
  let passed = true;
  let detail = '';
  try {
    detail = String((await run()) ?? '');
  } catch (error) {
    passed = false;
    detail = `${error.name}: ${error.message}`;
  }
  console.log(JSON.stringify({ client: 'sdk', check: name, passed, detail: detail.slice(0, 200) }));
}
const expect = (actual, wanted) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`got ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
  return JSON.stringify(actual).slice(0, 120);
};
const refusedAs = async (name, call) => {
  try {
    await call();
  } catch (error) {
    return expect(error.name, name);
  }
  throw new Error(`accepted, not refused ${name}`);
};
const bytes = async (body) => Buffer.from(await body.transformToByteArray());
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

await check('put and get, with its type and metadata', async () => {
  await objects.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: `${prefix}hello é.txt`, Body: 'Ahlan', ContentType: 'text/plain', Metadata: { owner: 'me' } }));
  const got = await objects.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}hello é.txt` }));
  return expect([(await bytes(got.Body)).toString(), got.ContentType, got.Metadata], ['Ahlan', 'text/plain', { owner: 'me' }]);
});
await check('put 5 MB as a stream, aws-chunked with a trailing checksum, and get the same bytes', async () => {
  const data = Buffer.alloc(5 * MB, 7);
  await objects.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: `${prefix}big.bin`, Body: Readable.from([data]), ContentLength: data.length }));
  return expect(sha256(await bytes((await objects.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}big.bin` }))).Body)), sha256(data));
});
await check('get a range', async () =>
  expect((await bytes((await objects.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}hello é.txt`, Range: 'bytes=0-2' }))).Body)).toString(), 'Ahl'),
);
await check('list by a prefix and a delimiter, then page by page', async () => {
  for (const key of ['a/1', 'a/2', 'b', 'c']) await objects.send(new s3.PutObjectCommand({ Bucket: BUCKET, Key: `${prefix}list/${key}`, Body: key }));
  const grouped = await objects.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}list/`, Delimiter: '/' }));
  expect([grouped.CommonPrefixes?.map((common) => common.Prefix), grouped.Contents?.map((object) => object.Key)], [[`${prefix}list/a/`], [`${prefix}list/b`, `${prefix}list/c`]]);
  const keys = [];
  let token;
  do {
    const page = await objects.send(new s3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${prefix}list/`, MaxKeys: 3, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((object) => object.Key.slice(prefix.length + 5)));
    token = page.NextContinuationToken;
  } while (token);
  return expect(keys, ['a/1', 'a/2', 'b', 'c']);
});
await check('a missing key: NoSuchKey', () => refusedAs('NoSuchKey', () => objects.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}nothing` }))));
await check('S3 with a wrong secret: SignatureDoesNotMatch', () =>
  refusedAs('SignatureDoesNotMatch', () =>
    new s3.S3Client({ endpoint: S3_ENDPOINT, region, credentials: wrong, forcePathStyle: true }).send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}hello é.txt` })),
  ),
);

let url = '';
await check("GetQueueUrl: the queue's URL under the endpoint and the account", async () => {
  url = (await queues.send(new sqs.GetQueueUrlCommand({ QueueName: QUEUE }))).QueueUrl;
  return expect(url, `${SQS_ENDPOINT}/${ACCOUNT}/${QUEUE}`);
});
let handle = '';
await check('send with attributes of each type and Arabic text; receive them back, the SDK checking the MD5 sums', async () => {
  const attributes = {
    city: { DataType: 'String', StringValue: 'تونس' },
    count: { DataType: 'Number', StringValue: '12' },
    raw: { DataType: 'Binary', BinaryValue: Buffer.from([0, 1, 2, 255]) },
  };
  await queues.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'مرحبا', MessageAttributes: attributes }));
  const [message] = (await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }))).Messages ?? [];
  handle = message?.ReceiptHandle ?? '';
  const got = message?.MessageAttributes ?? {};
  return expect(
    [message?.Body, got.city?.StringValue, got.count?.StringValue, Buffer.from(got.raw?.BinaryValue ?? []).toString('hex'), message?.Attributes?.ApproximateReceiveCount],
    ['مرحبا', 'تونس', '12', '000102ff', '1'],
  );
});
await check('delete it, then an empty queue answers after its wait', async () => {
  await queues.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: handle }));
  const started = Date.now();
  const answer = await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1 }));
  return expect([answer.Messages?.length ?? 0, Date.now() - started >= 900], [0, true]);
});
await check('a message sent during a long poll ends it at once', async () => {
  const started = Date.now();
  const polling = queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 10 }));
  await new Promise((done) => setTimeout(done, 300));
  await queues.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'during' }));
  const [message] = (await polling).Messages ?? [];
  await queues.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message?.ReceiptHandle }));
  return expect([message?.Body, Date.now() - started < 3000], ['during', true]);
});
await check('a queue that is not there: QueueDoesNotExist', () => refusedAs('QueueDoesNotExist', () => queues.send(new sqs.GetQueueUrlCommand({ QueueName: 'nowhere' }))));
await check('SQS with a wrong secret: SignatureDoesNotMatch', () =>
  refusedAs('SignatureDoesNotMatch', () => new sqs.SQSClient({ endpoint: SQS_ENDPOINT, region, credentials: wrong }).send(new sqs.GetQueueUrlCommand({ QueueName: QUEUE }))),
);

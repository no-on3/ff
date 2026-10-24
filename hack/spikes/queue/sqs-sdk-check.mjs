#!/usr/bin/env node
// AWS's SDK for JavaScript v3 (@aws-sdk/client-sqs) against the spike's SQS endpoint, with its defaults, as a customer's
// code has them: only the endpoint, the region and the key are given. One JSON line per check, as sqs.sh reads them.
//   MODULES=<folder with node_modules> ENDPOINT=http://127.0.0.1:<port> KEY=… SECRET=… node sqs-sdk-check.mjs
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const sqs = require('@aws-sdk/client-sqs');
const { ENDPOINT, KEY, SECRET } = process.env;
const region = 'tn-tunis-1';
const client = (credentials = { accessKeyId: KEY, secretAccessKey: SECRET }) => new sqs.SQSClient({ endpoint: ENDPOINT, region, credentials });
const sdk = client();

async function check(want, what, run) {
  let got = 'ok';
  let detail = '';
  try {
    detail = String((await run()) ?? '');
  } catch (error) {
    got = 'refused';
    detail = `${error.name}${error.Code ? ` (${error.Code})` : ''}: ${error.message}`.slice(0, 200);
  }
  console.log(JSON.stringify({ client: 'sdk-js', want, got, what, detail }));
}
const expect = (got, wanted, what = 'value') => {
  if (JSON.stringify(got) !== JSON.stringify(wanted)) throw new Error(`${what}: wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(got)}`);
  return JSON.stringify(got).slice(0, 120);
};
const send = (command) => sdk.send(command);

let url;
await check('ok', 'CreateQueue answers its URL, under the endpoint and the account', async () => {
  url = (await send(new sqs.CreateQueueCommand({ QueueName: 'sdk-orders' }))).QueueUrl;
  return expect(url, `${ENDPOINT}/000000000001/sdk-orders`, 'QueueUrl');
});
await check('ok', 'GetQueueUrl, ListQueues', async () => {
  expect((await send(new sqs.GetQueueUrlCommand({ QueueName: 'sdk-orders' }))).QueueUrl, url, 'QueueUrl');
  return expect((await send(new sqs.ListQueuesCommand({ QueueNamePrefix: 'sdk-' }))).QueueUrls, [url], 'QueueUrls');
});
const attributes = {
  kind: { DataType: 'String', StringValue: 'order' },
  quantity: { DataType: 'Number', StringValue: '2' },
  raw: { DataType: 'Binary', BinaryValue: Buffer.from([0, 1, 2, 255]) },
};
await check('ok', 'SendMessage with attributes of each type, its MD5 sums checked by the SDK', async () =>
  (await send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: '{"item":"harissa","quantity":2} é', MessageAttributes: attributes }))).MessageId);
await check('ok', 'ReceiveMessage gives it back, body and attributes as sent, its MD5 sums checked', async () => {
  const { Messages = [] } = await send(new sqs.ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] }));
  expect(Messages.length, 1, 'messages');
  expect(Messages[0].Body, '{"item":"harissa","quantity":2} é', 'Body');
  expect(Buffer.from(Messages[0].MessageAttributes.raw.BinaryValue).toString('hex'), '000102ff', 'binary attribute');
  expect(Messages[0].Attributes.ApproximateReceiveCount, '1', 'ApproximateReceiveCount');
  await send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: Messages[0].ReceiptHandle }));
  return `${Messages[0].MessageId}, deleted`;
});
await check('ok', 'long polling: an empty queue answers after its wait, about 2 s', async () => {
  const started = Date.now();
  const { Messages = [] } = await send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 2 }));
  const waited = Date.now() - started;
  if (Messages.length !== 0 || waited < 1800 || waited > 3500) throw new Error(`${Messages.length} messages after ${waited} ms`);
  return `${waited} ms`;
});
await check('ok', 'long polling: a message sent during the wait ends it at once', async () => {
  const started = Date.now();
  const waiting = send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 10 }));
  setTimeout(() => void send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'during the wait' })), 500);
  const { Messages = [] } = await waiting;
  const waited = Date.now() - started;
  expect(Messages.map((message) => message.Body), ['during the wait'], 'bodies');
  if (waited > 2500) throw new Error(`answered after ${waited} ms`);
  await send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: Messages[0].ReceiptHandle }));
  return `${waited} ms`;
});
await check('ok', 'SendMessageBatch of 10, ReceiveMessage of 10, DeleteMessageBatch of 10', async () => {
  const sent = await send(new sqs.SendMessageBatchCommand({ QueueUrl: url, Entries: Array.from({ length: 10 }, (_, n) => ({ Id: `m${n}`, MessageBody: `batch ${n}` })) }));
  expect(sent.Successful.length, 10, 'sent');
  const { Messages = [] } = await send(new sqs.ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
  expect(Messages.length, 10, 'received');
  const deleted = await send(new sqs.DeleteMessageBatchCommand({ QueueUrl: url, Entries: Messages.map((message, n) => ({ Id: `d${n}`, ReceiptHandle: message.ReceiptHandle })) }));
  return expect([deleted.Successful.length, deleted.Failed?.length ?? 0], [10, 0], 'deleted, failed');
});
await check('ok', 'ChangeMessageVisibility to 0 shows it again at once; its receive count says 2', async () => {
  await send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'seen twice' }));
  const first = (await send(new sqs.ReceiveMessageCommand({ QueueUrl: url, VisibilityTimeout: 60 }))).Messages ?? [];
  expect(((await send(new sqs.ReceiveMessageCommand({ QueueUrl: url }))).Messages ?? []).length, 0, 'while hidden');
  await send(new sqs.ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: first[0].ReceiptHandle, VisibilityTimeout: 0 }));
  const again = (await send(new sqs.ReceiveMessageCommand({ QueueUrl: url, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }))).Messages ?? [];
  expect(again[0]?.Attributes?.ApproximateReceiveCount, '2', 'ApproximateReceiveCount');
  await send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: again[0].ReceiptHandle }));
  return 'ok';
});
await check('ok', 'GetQueueAttributes counts what waits', async () =>
  expect((await send(new sqs.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }))).Attributes.ApproximateNumberOfMessages, '0', 'ApproximateNumberOfMessages'));
await check('refused', 'GetQueueUrl of a queue that is not there: QueueDoesNotExist', () => send(new sqs.GetQueueUrlCommand({ QueueName: 'nowhere' })));
await check('refused', 'a wrong secret: SignatureDoesNotMatch', () => client({ accessKeyId: KEY, secretAccessKey: 'wrong' }).send(new sqs.ListQueuesCommand({})));
await check('refused', 'an unknown key: InvalidClientTokenId', () => client({ accessKeyId: 'AKFFUNKNOWNUNKNOWN22', secretAccessKey: SECRET }).send(new sqs.ListQueuesCommand({})));
const wrong = (await send(new sqs.CreateQueueCommand({ QueueName: 'wrong-md5' }))).QueueUrl;
await check('refused', 'SendMessage answered with a wrong MD5 sum: the SDK says so', () => send(new sqs.SendMessageCommand({ QueueUrl: wrong, MessageBody: 'checked' })));
await check('refused', 'ReceiveMessage answered with a wrong MD5 sum: the SDK says so', () => send(new sqs.ReceiveMessageCommand({ QueueUrl: wrong, WaitTimeSeconds: 1 })));
await check('ok', 'PurgeQueue, DeleteQueue', async () => {
  await send(new sqs.PurgeQueueCommand({ QueueUrl: wrong }));
  await send(new sqs.DeleteQueueCommand({ QueueUrl: wrong }));
  await send(new sqs.DeleteQueueCommand({ QueueUrl: url }));
  return expect((await send(new sqs.ListQueuesCommand({}))).QueueUrls ?? [], [], 'QueueUrls');
});

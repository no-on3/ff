#!/usr/bin/env node
// AWS's SDK for JavaScript v3 against FF's SQS endpoint, with its defaults, as a customer's code has them: only the
// endpoint, the region and the key are given. One JSON line per check, {client, want, got, what}, for hack/e2e.sh.
//   MODULES=<folder with node_modules> ENDPOINT=http://localhost:<port> ACCOUNT=<12 digits> KEY=… SECRET=… \
//   OTHER_URL=<a queue of another account's> node sdk.mjs
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const sqs = require('@aws-sdk/client-sqs');
const { ENDPOINT, ACCOUNT, KEY, SECRET, OTHER_URL } = process.env;
const region = 'tn-tunis-1';
const client = (credentials = { accessKeyId: KEY, secretAccessKey: SECRET }) => new sqs.SQSClient({ endpoint: ENDPOINT, region, credentials, maxAttempts: 1 });
const queues = client();

async function check(want, what, run) {
  let got = 'ok';
  let detail = '';
  try {
    detail = String((await run()) ?? '');
  } catch (error) {
    got = 'refused';
    detail = `${error.name}${error.Code ? ` (${error.Code})` : ''}: ${error.message}`;
  }
  console.log(JSON.stringify({ client: 'sdk', want, got, what, detail: detail.slice(0, 200) }));
}
/** Fails unless the answer is what it should be. */
const expect = (actual, wanted) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`got ${JSON.stringify(actual)}, not ${JSON.stringify(wanted)}`);
  return JSON.stringify(actual);
};
/** Refused, as the error SQS names: its name and its query code, as the SDK reads them. */
const refusedAs = async (run, name, code) => {
  try {
    await run();
  } catch (error) {
    return expect(`${error.name} ${error.Code ?? ''}`.trim(), `${name} ${code ?? ''}`.trim());
  }
  throw new Error('accepted');
};

let url;
await check('ok', 'CreateQueue answers its URL, under the endpoint and the account', async () => {
  url = (await queues.send(new sqs.CreateQueueCommand({ QueueName: 'e2e-sdk-orders', Attributes: { VisibilityTimeout: '5' } }))).QueueUrl;
  return expect(url, `${ENDPOINT}/${ACCOUNT}/e2e-sdk-orders`);
});
await check('ok', 'GetQueueUrl by its name, ListQueues by a prefix', async () => {
  expect((await queues.send(new sqs.GetQueueUrlCommand({ QueueName: 'e2e-sdk-orders' }))).QueueUrl, url);
  return expect((await queues.send(new sqs.ListQueuesCommand({ QueueNamePrefix: 'e2e-sdk-' }))).QueueUrls, [url]);
});
const attributes = {
  item: { DataType: 'String', StringValue: 'harissa' },
  quantity: { DataType: 'Number', StringValue: '2' },
  label: { DataType: 'Binary.png', BinaryValue: new Uint8Array([137, 80, 78, 71]) },
};
await check('ok', 'SendMessage with attributes of each type and Arabic text; ReceiveMessage gives them back, the SDK checking the MD5 sums', async () => {
  const sent = await queues.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: '{"order":7} طلب', MessageAttributes: attributes }));
  const { Messages = [] } = await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 2, MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'] }));
  const [message] = Messages;
  expect([message?.MessageId, message?.Body, message?.MD5OfMessageAttributes], [sent.MessageId, '{"order":7} طلب', sent.MD5OfMessageAttributes]);
  expect([message.MessageAttributes.item.StringValue, message.MessageAttributes.quantity.StringValue, [...message.MessageAttributes.label.BinaryValue]], ['harissa', '2', [137, 80, 78, 71]]);
  await queues.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
  return expect([message.Attributes.SenderId, message.Attributes.ApproximateReceiveCount], [KEY, '1']);
});
await check('ok', 'a long poll: an empty queue answers after its wait, and a message sent during one ends it at once', async () => {
  let started = Date.now();
  expect((await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 1 }))).Messages, undefined);
  if (Date.now() - started < 900) throw new Error(`answered after ${Date.now() - started} ms, before its wait`);
  started = Date.now();
  const waiting = queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, WaitTimeSeconds: 10 }));
  setTimeout(() => void client().send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'during the wait' })), 500);
  const { Messages = [] } = await waiting;
  const waited = Date.now() - started;
  expect(Messages.map((message) => message.Body), ['during the wait']);
  if (waited > 2000) throw new Error(`answered after ${waited} ms`);
  await queues.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: Messages[0].ReceiptHandle }));
  return `${waited} ms`;
});
await check('ok', 'SendMessageBatch of 10, ReceiveMessage of 10, DeleteMessageBatch of 10', async () => {
  const sent = await queues.send(new sqs.SendMessageBatchCommand({ QueueUrl: url, Entries: Array.from({ length: 10 }, (_, n) => ({ Id: `m${n}`, MessageBody: `batch ${n}` })) }));
  const { Messages = [] } = await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10 }));
  const deleted = await queues.send(new sqs.DeleteMessageBatchCommand({ QueueUrl: url, Entries: Messages.map((message, n) => ({ Id: `d${n}`, ReceiptHandle: message.ReceiptHandle })) }));
  return expect([sent.Successful.length, Messages.length, deleted.Successful.length, deleted.Failed?.length ?? 0], [10, 10, 10, 0]);
});
await check('ok', 'a message not deleted comes back after its visibility timeout, or at once once its visibility is changed', async () => {
  await queues.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'seen twice' }));
  const first = (await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url }))).Messages[0];
  expect((await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url }))).Messages, undefined);
  await queues.send(new sqs.ChangeMessageVisibilityCommand({ QueueUrl: url, ReceiptHandle: first.ReceiptHandle, VisibilityTimeout: 0 }));
  const again = (await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: url, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }))).Messages[0];
  await queues.send(new sqs.DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: again.ReceiptHandle }));
  return expect([again.MessageId, again.Attributes.ApproximateReceiveCount], [first.MessageId, '2']);
});
await check('ok', "a dead-letter queue takes a message received as often as the redrive policy allows", async () => {
  const deadLetter = (await queues.send(new sqs.CreateQueueCommand({ QueueName: 'e2e-sdk-orders-dlq' }))).QueueUrl;
  const arn = (await queues.send(new sqs.GetQueueAttributesCommand({ QueueUrl: deadLetter, AttributeNames: ['QueueArn'] }))).Attributes.QueueArn;
  const poisoned = (await queues.send(new sqs.CreateQueueCommand({ QueueName: 'e2e-sdk-poisoned', Attributes: { VisibilityTimeout: '0', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 1 }) } }))).QueueUrl;
  const sent = await queues.send(new sqs.SendMessageCommand({ QueueUrl: poisoned, MessageBody: 'poison' }));
  expect((await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: poisoned }))).Messages.length, 1);
  expect((await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: poisoned }))).Messages, undefined);
  const moved = (await queues.send(new sqs.ReceiveMessageCommand({ QueueUrl: deadLetter }))).Messages[0];
  await queues.send(new sqs.DeleteQueueCommand({ QueueUrl: poisoned }));
  await queues.send(new sqs.DeleteQueueCommand({ QueueUrl: deadLetter }));
  return expect([arn, moved.MessageId, moved.Body], [`arn:aws:sqs:${region}:${ACCOUNT}:e2e-sdk-orders-dlq`, sent.MessageId, 'poison']);
});
await check('ok', "GetQueueAttributes: SQS's attributes, the queue's own values and its counts", async () => {
  await queues.send(new sqs.SendMessageCommand({ QueueUrl: url, MessageBody: 'counted', DelaySeconds: 60 }));
  const { Attributes } = await queues.send(new sqs.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }));
  return expect([Attributes.VisibilityTimeout, Attributes.MessageRetentionPeriod, Attributes.ApproximateNumberOfMessagesDelayed], ['5', '345600', '1']);
});
await check('ok', 'a queue that is not there: QueueDoesNotExist, by both its names', () => refusedAs(() => queues.send(new sqs.GetQueueUrlCommand({ QueueName: 'nowhere' })), 'QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'));
await check('ok', "another account's queue, by its URL: one that doesn't exist", () =>
  refusedAs(() => queues.send(new sqs.SendMessageCommand({ QueueUrl: OTHER_URL, MessageBody: 'not mine' })), 'QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'));
await check('ok', 'a wrong secret: SignatureDoesNotMatch', () => refusedAs(() => client({ accessKeyId: KEY, secretAccessKey: 'wrong-secret' }).send(new sqs.ListQueuesCommand({})), 'SignatureDoesNotMatch', 'SignatureDoesNotMatch'));
await check('ok', 'an unknown key: InvalidClientTokenId', () =>
  refusedAs(() => client({ accessKeyId: 'AKFFAAAAAAAAAAAAAAAA', secretAccessKey: SECRET }).send(new sqs.ListQueuesCommand({})), 'InvalidClientTokenId', 'InvalidClientTokenId'));
await check('ok', 'PurgeQueue, then DeleteQueue', async () => {
  await queues.send(new sqs.PurgeQueueCommand({ QueueUrl: url }));
  await queues.send(new sqs.DeleteQueueCommand({ QueueUrl: url }));
  return expect((await queues.send(new sqs.ListQueuesCommand({ QueueNamePrefix: 'e2e-sdk-' }))).QueueUrls, undefined);
});

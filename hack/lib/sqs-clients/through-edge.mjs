#!/usr/bin/env node
// AWS's SDK for JavaScript v3 through FF's edge, as a customer reaches the SQS endpoint from outside: TLS checked with
// the test's authority, the endpoint's host taken to this machine. One JSON object on stdout, for hack/e2e-platform.sh.
//   MODULES=<folder with node_modules> ENDPOINT=https://sqs.ff.test:<port> CA=<root.crt> KEY=… SECRET=… QUEUE=<name> \
//   node through-edge.mjs create|receive
import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const sqs = require('@aws-sdk/client-sqs');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const { ENDPOINT, CA, KEY, SECRET, QUEUE } = process.env;
// Every name to this machine, where the cluster's edge answers on the port.
const lookup = (_hostname, options, callback) => (options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4));
const client = new sqs.SQSClient({
  endpoint: ENDPOINT,
  region: 'tn-tunis-1',
  credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
  requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ ca: readFileSync(CA), lookup }) }),
  maxAttempts: 1,
});

if (process.argv[2] === 'create') {
  const { QueueUrl } = await client.send(new sqs.CreateQueueCommand({ QueueName: QUEUE }));
  await client.send(new sqs.SendMessageCommand({ QueueUrl, MessageBody: 'sent through the edge' }));
  console.log(JSON.stringify({ url: QueueUrl }));
} else {
  const { QueueUrl } = await client.send(new sqs.GetQueueUrlCommand({ QueueName: QUEUE }));
  const { Messages = [] } = await client.send(new sqs.ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 2 }));
  await client.send(new sqs.DeleteQueueCommand({ QueueUrl }));
  console.log(JSON.stringify({ bodies: Messages.map((message) => message.Body).sort() }));
}

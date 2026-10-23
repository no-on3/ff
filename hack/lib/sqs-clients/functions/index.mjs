// A function as it would run on AWS Lambda with its role: AWS's SDK for JavaScript v3 with no setting at all. FF gives
// its pods a key of the function's own, the region and the SQS endpoint in their environment, which the SDK reads.
import { GetQueueUrlCommand, SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

/** How a send ends: sent, or the error's code or name. */
async function send(client, QueueUrl, MessageBody) {
  try {
    await client.send(new SendMessageCommand({ QueueUrl, MessageBody }));
    return 'sent';
  } catch (error) {
    return error.code ?? error.name;
  }
}

export const handler = async (event) => {
  // The queue by its name: its URL as FF's endpoint inside the cluster answers it, under that endpoint.
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: event.queue }));
  const byName = await send(sqs, QueueUrl, 'sent by a Node.js function');
  // A URL from outside: the SDK sends its requests to the URL's host, unless told to keep to its endpoint.
  const fromOutside = await send(sqs, event.publicUrl, 'not sent');
  const keptToEndpoint = await send(new SQSClient({ useQueueUrlAsEndpoint: false }), event.publicUrl, 'sent by a Node.js function, to the URL from outside');
  // Another account's queue, by its URL inside the cluster: one that doesn't exist.
  const other = await send(sqs, `${new URL(QueueUrl).origin}/${event.otherAccount}/${event.queue}`, 'not mine');
  return { url: QueueUrl, byName, fromOutside, keptToEndpoint, other };
};

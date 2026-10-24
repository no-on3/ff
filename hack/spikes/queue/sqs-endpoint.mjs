#!/usr/bin/env node
// A minimal Amazon SQS endpoint, Node.js's standard library only, for step 3's spike (the step-3 plan's Q-01): SQS's
// JSON 1.0 protocol (POST /, X-Amz-Target: AmazonSQS.<Operation>), AWS Signature Version 4 for the service sqs with
// one key, queues in memory, long polling, and the MD5 sums SQS answers, of a body and of its attributes, which AWS's
// SDKs may check. What AWS's SDK for JavaScript v3, boto3 and the AWS CLI make of it is sqs.sh's question.
//   PORT=… KEY=AKFF… SECRET=… [ACCOUNT=000000000001] [REGION=tn-tunis-1] node sqs-endpoint.mjs
// A queue named wrong-md5 answers MD5 sums that don't match, so that a client that checks them says so.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const { PORT, KEY, SECRET } = process.env;
const ACCOUNT = process.env.ACCOUNT ?? '000000000001';
const REGION = process.env.REGION ?? 'tn-tunis-1';
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
const MAX_SKEW_MS = 15 * 60_000;

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const md5hex = (data) => createHash('md5').update(data).digest('hex');

class SqsError extends Error {
  constructor(status, type, message, queryCode) {
    super(message);
    this.status = status;
    this.type = type;
    this.queryCode = queryCode;
  }
}
const missingQueue = () => new SqsError(400, 'QueueDoesNotExist', 'The specified queue does not exist.', 'AWS.SimpleQueueService.NonExistentQueue;Sender');
const invalidParameter = (message) => new SqsError(400, 'InvalidParameterValue', message, 'InvalidParameterValue;Sender');

/** The request's signature, checked as SQS checks one: the key, the scope's date and region and service, the time, then the HMAC. */
function verify(request, body) {
  const auth = request.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(auth);
  if (!match) throw new SqsError(403, 'MissingAuthenticationToken', 'Request is missing Authentication Token', 'MissingAuthenticationToken;Sender');
  const [, key, date, region, service, signedHeaders, signature] = match;
  if (key !== KEY) throw new SqsError(403, 'InvalidClientTokenId', 'The security token included in the request is invalid.', 'InvalidClientTokenId;Sender');
  if (service !== 'sqs' || region !== REGION) throw new SqsError(403, 'SignatureDoesNotMatch', `Credential should be scoped to a valid region and the service sqs, not '${region}/${service}'.`);
  const amzDate = request.headers['x-amz-date'] ?? '';
  const signedAt = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > MAX_SKEW_MS) throw new SqsError(403, 'SignatureDoesNotMatch', 'Signature expired.');
  // Each signed header's value as the client sent it, trimmed, inner spaces folded, repeats joined by commas.
  const values = new Map();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i].toLowerCase();
    const value = request.rawHeaders[i + 1].trim().replace(/\s+/g, ' ');
    values.set(name, values.has(name) ? `${values.get(name)},${value}` : value);
  }
  const names = signedHeaders.split(';');
  if (!names.includes('host')) throw new SqsError(403, 'SignatureDoesNotMatch', 'host must be signed');
  const [path, query = ''] = (request.url ?? '/').split('?');
  const canonicalQuery = query
    .split('&')
    .filter(Boolean)
    .map((pair) => pair.split('='))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value = '']) => `${name}=${value}`)
    .join('&');
  const canonical = ['POST', path || '/', canonicalQuery, names.map((name) => `${name}:${values.get(name) ?? ''}\n`).join(''), signedHeaders, sha256hex(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const signingKey = ['aws4_request'].reduce((k, part) => hmac(k, part), hmac(hmac(hmac(`AWS4${SECRET}`, date), region), service));
  const expected = createHmac('sha256', signingKey).update(toSign).digest('hex');
  if (expected !== signature) {
    throw new SqsError(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.', 'SignatureDoesNotMatch;Sender');
  }
}

/** SQS's MD5 of a message's attributes: each, by name, as length-prefixed name, type, transport byte and value. */
function attributesMd5(attributes) {
  const names = Object.keys(attributes ?? {}).sort();
  if (names.length === 0) return undefined;
  const parts = [];
  const lengthPrefixed = (buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(buffer.length);
    parts.push(length, buffer);
  };
  for (const name of names) {
    const { DataType, StringValue, BinaryValue } = attributes[name];
    lengthPrefixed(Buffer.from(name, 'utf8'));
    lengthPrefixed(Buffer.from(DataType, 'utf8'));
    if (BinaryValue !== undefined) {
      parts.push(Buffer.from([2]));
      lengthPrefixed(Buffer.from(BinaryValue, 'base64'));
    } else {
      parts.push(Buffer.from([1]));
      lengthPrefixed(Buffer.from(StringValue ?? '', 'utf8'));
    }
  }
  return md5hex(Buffer.concat(parts));
}

const queues = new Map();
const waiting = new Set();
const urlOf = (name) => `${BASE}/${ACCOUNT}/${name}`;
function queueOf(url) {
  const name = typeof url === 'string' ? url.split('/').pop() : undefined;
  const queue = name && queues.get(name);
  if (!queue || !url.endsWith(`/${ACCOUNT}/${name}`)) throw missingQueue();
  return queue;
}
const wrongMd5 = (queue, md5) => (queue.name === 'wrong-md5' ? md5hex(`not ${md5}`) : md5);
function enqueue(queue, entry) {
  if (typeof entry.MessageBody !== 'string' || entry.MessageBody === '') throw invalidParameter('The request must contain the parameter MessageBody.');
  const message = {
    id: randomUUID(),
    body: entry.MessageBody,
    attributes: entry.MessageAttributes,
    sentAt: Date.now(),
    visibleAt: Date.now() + 1000 * (entry.DelaySeconds ?? 0),
    receives: 0,
    receipt: null,
  };
  queue.messages.push(message);
  for (const waiter of waiting) waiter();
  return {
    MessageId: message.id,
    MD5OfMessageBody: wrongMd5(queue, md5hex(message.body)),
    ...(attributesMd5(message.attributes) ? { MD5OfMessageAttributes: wrongMd5(queue, attributesMd5(message.attributes)) } : {}),
  };
}
function take(queue, max, visibility) {
  const now = Date.now();
  const taken = queue.messages.filter((message) => message.visibleAt <= now).slice(0, max);
  for (const message of taken) {
    message.receives += 1;
    message.firstReceivedAt ??= now;
    message.visibleAt = now + 1000 * visibility;
    message.receipt = `${message.id}.${randomBytes(12).toString('base64url')}`;
  }
  return taken;
}

const operations = {
  CreateQueue({ QueueName, Attributes }) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(QueueName ?? '')) throw invalidParameter('Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length');
    if (!queues.has(QueueName)) {
      queues.set(QueueName, { name: QueueName, messages: [], createdAt: Date.now(), visibility: Number(Attributes?.VisibilityTimeout ?? 30) });
    }
    return { QueueUrl: urlOf(QueueName) };
  },
  GetQueueUrl({ QueueName }) {
    if (!queues.has(QueueName)) throw missingQueue();
    return { QueueUrl: urlOf(QueueName) };
  },
  ListQueues({ QueueNamePrefix = '' }) {
    return { QueueUrls: [...queues.keys()].filter((name) => name.startsWith(QueueNamePrefix)).map(urlOf) };
  },
  GetQueueAttributes({ QueueUrl }) {
    const queue = queueOf(QueueUrl);
    const now = Date.now();
    return {
      Attributes: {
        QueueArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${queue.name}`,
        ApproximateNumberOfMessages: String(queue.messages.filter((message) => message.visibleAt <= now).length),
        ApproximateNumberOfMessagesNotVisible: String(queue.messages.filter((message) => message.visibleAt > now).length),
        VisibilityTimeout: String(queue.visibility),
        CreatedTimestamp: String(Math.floor(queue.createdAt / 1000)),
      },
    };
  },
  SendMessage(input) {
    return enqueue(queueOf(input.QueueUrl), input);
  },
  SendMessageBatch({ QueueUrl, Entries }) {
    const queue = queueOf(QueueUrl);
    return { Successful: Entries.map((entry) => ({ Id: entry.Id, ...enqueue(queue, entry) })), Failed: [] };
  },
  async ReceiveMessage({ QueueUrl, MaxNumberOfMessages = 1, VisibilityTimeout, WaitTimeSeconds = 0, MessageAttributeNames = [] }) {
    const queue = queueOf(QueueUrl);
    if (MaxNumberOfMessages < 1 || MaxNumberOfMessages > 10) throw invalidParameter('Value for parameter MaxNumberOfMessages is invalid. Must be between 1 and 10.');
    const deadline = Date.now() + 1000 * Math.min(WaitTimeSeconds, 20);
    let taken = take(queue, MaxNumberOfMessages, VisibilityTimeout ?? queue.visibility);
    // Long polling: the request waits until a message is sent, or its wait is up.
    while (taken.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        const wake = () => {
          waiting.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()));
        waiting.add(wake);
      });
      taken = take(queue, MaxNumberOfMessages, VisibilityTimeout ?? queue.visibility);
    }
    const all = MessageAttributeNames.includes('All') || MessageAttributeNames.includes('.*');
    const messages = taken.map((message) => {
      const attributes = Object.fromEntries(Object.entries(message.attributes ?? {}).filter(([name]) => all || MessageAttributeNames.includes(name)));
      const md5 = attributesMd5(attributes);
      return {
        MessageId: message.id,
        ReceiptHandle: message.receipt,
        MD5OfBody: wrongMd5(queue, md5hex(message.body)),
        Body: message.body,
        Attributes: {
          SentTimestamp: String(message.sentAt),
          ApproximateReceiveCount: String(message.receives),
          ApproximateFirstReceiveTimestamp: String(message.firstReceivedAt),
          SenderId: KEY,
        },
        ...(md5 ? { MD5OfMessageAttributes: wrongMd5(queue, md5), MessageAttributes: attributes } : {}),
      };
    });
    return messages.length ? { Messages: messages } : {};
  },
  DeleteMessage({ QueueUrl, ReceiptHandle }) {
    const queue = queueOf(QueueUrl);
    const at = queue.messages.findIndex((message) => message.receipt === ReceiptHandle);
    if (at < 0) throw new SqsError(400, 'ReceiptHandleIsInvalid', 'The input receipt handle is invalid.', 'ReceiptHandleIsInvalid;Sender');
    queue.messages.splice(at, 1);
    return {};
  },
  DeleteMessageBatch({ QueueUrl, Entries }) {
    const queue = queueOf(QueueUrl);
    const Successful = [];
    const Failed = [];
    for (const entry of Entries) {
      const at = queue.messages.findIndex((message) => message.receipt === entry.ReceiptHandle);
      if (at < 0) Failed.push({ Id: entry.Id, Code: 'ReceiptHandleIsInvalid', SenderFault: true, Message: 'The input receipt handle is invalid.' });
      else {
        queue.messages.splice(at, 1);
        Successful.push({ Id: entry.Id });
      }
    }
    return { Successful, Failed };
  },
  ChangeMessageVisibility({ QueueUrl, ReceiptHandle, VisibilityTimeout }) {
    const message = queueOf(QueueUrl).messages.find((candidate) => candidate.receipt === ReceiptHandle);
    if (!message) throw new SqsError(400, 'ReceiptHandleIsInvalid', 'The input receipt handle is invalid.', 'ReceiptHandleIsInvalid;Sender');
    message.visibleAt = Date.now() + 1000 * VisibilityTimeout;
    return {};
  },
  PurgeQueue({ QueueUrl }) {
    queueOf(QueueUrl).messages.length = 0;
    return {};
  },
  DeleteQueue({ QueueUrl }) {
    queues.delete(queueOf(QueueUrl).name);
    return {};
  },
};

const seen = { requests: 0, byOperation: {}, userAgents: new Set() };
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const requestId = randomUUID();
  const reply = (status, document, headers = {}) => {
    const text = JSON.stringify(document);
    response.writeHead(status, { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': requestId, 'content-length': Buffer.byteLength(text), ...headers });
    response.end(text);
  };
  try {
    if (request.method !== 'POST') throw new SqsError(405, 'InvalidAction', 'SQS takes POST /');
    verify(request, body);
    const target = request.headers['x-amz-target'] ?? '';
    const name = target.startsWith('AmazonSQS.') ? target.slice('AmazonSQS.'.length) : '';
    const operation = operations[name];
    if (!operation) throw new SqsError(400, 'InvalidAction', `The action ${name || target} is not valid for this endpoint.`, 'InvalidAction;Sender');
    if (!/^application\/x-amz-json-1\.0/.test(request.headers['content-type'] ?? '')) throw invalidParameter('Content-Type must be application/x-amz-json-1.0');
    seen.requests += 1;
    seen.byOperation[name] = (seen.byOperation[name] ?? 0) + 1;
    seen.userAgents.add(String(request.headers['user-agent'] ?? '').split(' ')[0]);
    reply(200, await operation(JSON.parse(body.toString('utf8') || '{}')));
  } catch (error) {
    if (!(error instanceof SqsError)) {
      console.error(error);
      error = new SqsError(500, 'InternalError', 'We encountered an internal error. Please try again.');
    }
    reply(error.status, { __type: `com.amazonaws.sqs#${error.type}`, message: error.message }, error.queryCode ? { 'x-amzn-query-error': error.queryCode } : {});
  }
});
server.listen(Number(PORT), '127.0.0.1', () => console.error(`sqs-endpoint on ${BASE}`));
process.on('SIGTERM', () => {
  console.error(JSON.stringify({ requests: seen.requests, byOperation: seen.byOperation, userAgents: [...seen.userAgents] }));
  server.close();
  process.exit(0);
});

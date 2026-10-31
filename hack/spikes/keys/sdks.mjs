// AWS's SDK for JavaScript past its key's end: one call to each of S3, SQS, SES and Lambda at ENDPOINT, which answers
// each as the service answers a key that has expired (expired.mjs), the key and region from the environment as a
// function's pod has them. One JSON line per service: what the SDK threw, the HTTP status, the attempts it made and
// the requests the endpoint counted, and how long the call took, the SDK's own retries and waits included.
//   MODULES=<node_modules> ENDPOINT=http://127.0.0.1:<port> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_REGION=… node sdks.mjs
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ListQueuesCommand } = require('@aws-sdk/client-sqs');
const { SESv2Client, GetAccountCommand } = require('@aws-sdk/client-sesv2');
const { LambdaClient, GetFunctionCommand } = require('@aws-sdk/client-lambda');

const endpoint = process.env.ENDPOINT;
const counts = async () => (await fetch(`${endpoint}/count`)).json();
const calls = {
  s3: () => new S3Client({ endpoint, forcePathStyle: true }).send(new GetObjectCommand({ Bucket: 'spike', Key: 'k' })),
  sqs: () => new SQSClient({ endpoint }).send(new ListQueuesCommand({})),
  ses: () => new SESv2Client({ endpoint }).send(new GetAccountCommand({})),
  lambda: () => new LambdaClient({ endpoint }).send(new GetFunctionCommand({ FunctionName: 'spike' })),
};

for (const [service, call] of Object.entries(calls)) {
  const before = (await counts())[service] ?? 0;
  const started = Date.now();
  const line = { sdk: 'js', service };
  try {
    await call();
    line.threw = 'nothing';
  } catch (error) {
    Object.assign(line, {
      threw: error.name,
      message: error.message,
      status: error.$metadata?.httpStatusCode,
      attempts: error.$metadata?.attempts,
      retryable: Boolean(error.$retryable),
    });
  }
  line.requests = ((await counts())[service] ?? 0) - before;
  line.ms = Date.now() - started;
  console.log(JSON.stringify(line));
}

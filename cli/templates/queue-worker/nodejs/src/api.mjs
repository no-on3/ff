// {{name}}'s API, at its function's URL: POST /jobs takes a job, {"task": "…", …}, into the queue, and answers 202
// with its ID; the worker does it later. The event is Lambda's URL event (version 2.0) and the answer a URL's
// response, the same on FF and on AWS Lambda. JOBS_QUEUE_URL names the queue, as template.yaml sets it; AWS's SDK
// finds its endpoint and its key in the function's environment, on FF as on AWS.

/** A request that can't be taken: its answer is 400 with the message. */
class Invalid extends Error {}

/** The largest job, as SQS's largest message is 256 KiB. */
const MOST_BYTES = 262_144;

export async function handler(event) {
  return route(event, send);
}

/** The request's answer, the job given to `send` to put in the queue: the tests give their own. */
export async function route(event, send) {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  if (!/^\/jobs\/?$/.test(path)) return answer(404, { message: `No route for ${path}` });
  if (method !== 'POST') return answer(405, { message: `${path} takes POST, not ${method}` }, { allow: 'POST' });
  try {
    const job = jobOf(event);
    return answer(202, { id: await send(JSON.stringify(job)), task: job.task });
  } catch (error) {
    if (error instanceof Invalid) return answer(400, { message: error.message });
    throw error;
  }
}

function jobOf(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  if (Buffer.byteLength(text) > MOST_BYTES) {
    throw new Invalid(`A job is ${MOST_BYTES} bytes at most, as SQS's messages`);
  }
  let job;
  try {
    job = JSON.parse(text);
  } catch {
    throw new Invalid('The body is JSON: {"task": "…"}');
  }
  if (typeof job !== 'object' || job === null || Array.isArray(job)) {
    throw new Invalid('A job is an object: {"task": "…"}');
  }
  if (typeof job.task !== 'string' || job.task.length === 0 || job.task.length > 100) {
    throw new Invalid('A job names its task, {"task": "…"}, 1 to 100 characters');
  }
  return job;
}

function answer(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

// The queue's client, made at the first call and kept for the calls after.
let sender;

async function send(body) {
  sender ??= await opened(process.env.JOBS_QUEUE_URL);
  return sender(body);
}

async function opened(url) {
  if (!url) throw new Error('JOBS_QUEUE_URL is not set: template.yaml sets it to the queue it makes');
  // Loaded here, so that the tests run without it installed.
  const { SendMessageCommand, SQSClient } = await import('@aws-sdk/client-sqs');
  const sqs = new SQSClient({});
  return async (body) => (await sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body }))).MessageId;
}

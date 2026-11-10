// {{name}}'s API, at its function's URL, which the page in site/ calls: a guestbook, each entry an object of its
// bucket. The event is Lambda's URL event (version 2.0) and the answer a URL's response, the same on FF and on AWS
// Lambda.
//   GET  /entries   the latest 20 entries, the newest first
//   POST /entries   {"name": "…", "message": "…"}: the entry kept, 201 with it
// ENTRIES_BUCKET names the bucket; AWS's SDK finds its endpoint and its key in the function's environment, on FF as on
// AWS. The browser's CORS is the URL's, as template.yaml sets it: this code never answers a preflight.
import { randomBytes } from 'node:crypto';

/** A request that can't be taken: its answer is 400 with the message. */
class Invalid extends Error {}

/** How many entries GET /entries gives, the newest first. */
export const LATEST = 20;
/** The last millisecond an entry's ID counts down from, in the year 2286: 13 digits. */
const LAST_MILLISECOND = 9_999_999_999_999;

export async function handler(event) {
  return route(event, await entries());
}

/** The request's answer, the entries kept in `bucket`: the tests give their own. */
export async function route(event, bucket) {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  if (!/^\/entries\/?$/.test(path)) return answer(404, { message: `No route for ${path}` });
  if (method === 'GET') return answer(200, await latest(bucket));
  if (method !== 'POST') {
    return answer(405, { message: `${path} takes GET, POST, not ${method}` }, { allow: 'GET, POST' });
  }
  try {
    return answer(201, await kept(bucket, entryOf(event)));
  } catch (error) {
    if (error instanceof Invalid) return answer(400, { message: error.message });
    throw error;
  }
}

/**
 * An entry's ID, made at `date`: the milliseconds left until LAST_MILLISECOND, then a random part, so that the
 * bucket, which lists its keys in order, lists the newest first.
 */
export function idOf(date, random = randomBytes(4).toString('hex')) {
  return `${String(LAST_MILLISECOND - date.getTime()).padStart(13, '0')}-${random}`;
}

async function latest(bucket) {
  const keys = await bucket.keys('entries/', LATEST);
  return Promise.all(keys.map(async (key) => JSON.parse(await bucket.get(key))));
}

async function kept(bucket, { name, message }) {
  const now = new Date();
  const entry = { id: idOf(now), name, message, at: now.toISOString() };
  await bucket.put(`entries/${entry.id}.json`, JSON.stringify(entry));
  return entry;
}

function entryOf(event) {
  const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Invalid('The body is JSON: {"name": "…", "message": "…"}');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Invalid('An entry is an object: {"name": "…", "message": "…"}');
  }
  const name = textOf(body.name, 'a name', 50);
  const message = textOf(body.message, 'a message', 500);
  return { name, message };
}

/** A field's text, trimmed, between 1 and `most` characters. */
function textOf(value, what, most) {
  const text = typeof value === 'string' ? value.trim() : '';
  const length = [...text].length;
  if (length < 1 || length > most) throw new Invalid(`An entry has ${what}, 1 to ${most} characters`);
  return text;
}

function answer(status, body, headers = {}) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

// The bucket, made at the first call and kept for the calls after.
let bucket;

async function entries() {
  bucket ??= await opened(process.env.ENTRIES_BUCKET);
  return bucket;
}

async function opened(name) {
  if (!name) throw new Error('ENTRIES_BUCKET is not set: template.yaml sets it to the bucket it makes');
  // Loaded here, so that the tests run without it installed.
  const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({});
  return {
    async keys(prefix, most) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix, MaxKeys: most }));
      return (page.Contents ?? []).map((object) => object.Key);
    },
    async get(key) {
      const object = await s3.send(new GetObjectCommand({ Bucket: name, Key: key }));
      return object.Body.transformToString();
    },
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: 'application/json' }));
    },
  };
}

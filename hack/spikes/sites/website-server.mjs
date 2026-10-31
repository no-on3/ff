#!/usr/bin/env node
// A website server for step 4's spike (the step-4 plan's W-01): a bucket's files read from the S3 store and streamed to
// a browser through Node.js, as the backend's own would serve them. GET and HEAD; a folder's index document, and a
// folder named without its slash redirected to it, as S3's website endpoint does; the error document with 404, or, for
// a single-page app, the index document with 200, as CloudFront's custom error response gives it; the store's ETag,
// Last-Modified, 304 and ranges; the content type stored, else by the file's name; nosniff. Counts its requests and
// bytes, and prints them with its memory when it stops. Node.js's standard library only.
//   PORT=… STORE=http://127.0.0.1:8333 STORE_KEY=… STORE_SECRET=… BUCKET=… [SPA=1] node website-server.mjs
import { Agent, createServer, request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { encodeKey, signed } from './sign.mjs';

const { PORT, STORE, STORE_KEY, STORE_SECRET, BUCKET } = process.env;
const SPA = process.env.SPA === '1';
const INDEX = 'index.html';
const ERROR = '404.html';
const store = new URL(STORE);
const agent = new Agent({ keepAlive: true, maxSockets: 128 });
const counted = { requests: 0, bytesOut: 0, storeRequests: 0, byStatus: {} };

// What a store gives objects uploaded without a type: the name says more.
const UNTYPED = new Set(['', 'binary/octet-stream', 'application/octet-stream']);
const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
};
const typeOf = (key) => TYPES[key.slice(key.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
const PASSED = ['if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'range'];
const ANSWERED = ['content-length', 'content-range', 'etag', 'last-modified', 'accept-ranges', 'cache-control', 'content-encoding'];

/** The store's answer for one object: GET or HEAD, the browser's conditions and range passed on. */
function fromStore(method, key, browser) {
  counted.storeRequests++;
  const headers = Object.fromEntries(PASSED.filter((name) => browser[name] !== undefined).map((name) => [name, browser[name]]));
  const path = `/${BUCKET}/${encodeKey(key)}`;
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: store.hostname, port: store.port, method, path, agent, headers: signed({ method, host: store.host, path, headers, key: STORE_KEY, secret: STORE_SECRET }) },
      resolve,
    );
    request.once('error', reject);
    request.end();
  });
}

/** Sends a store's answer for a key on, with the status given or its own. */
async function relay(method, response, answer, key, status = answer.statusCode) {
  const headers = { 'x-content-type-options': 'nosniff' };
  for (const name of ANSWERED) if (answer.headers[name] !== undefined) headers[name] = answer.headers[name];
  const stored = (answer.headers['content-type'] ?? '').split(';')[0].trim();
  if (status !== 304) headers['content-type'] = UNTYPED.has(stored) ? typeOf(key) : answer.headers['content-type'];
  response.writeHead(status, headers);
  if (method === 'HEAD' || status === 304) {
    answer.resume();
    response.end();
    return status;
  }
  answer.on('data', (chunk) => (counted.bytesOut += chunk.length));
  await pipeline(answer, response);
  return status;
}

async function answer(request, response) {
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-length': 0 });
    response.end();
    return 405;
  }
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const key = (path.endsWith('/') ? `${path}${INDEX}` : path).replace(/^\//, '');
  const found = await fromStore(method, key, request.headers);
  if (found.statusCode !== 404) return relay(method, response, found, key);
  found.resume();
  // A folder named without its slash: S3's website endpoint redirects to it when it has an index document.
  if (!path.endsWith('/')) {
    const folder = await fromStore('HEAD', `${key}/${INDEX}`, {});
    folder.resume();
    if (folder.statusCode === 200) {
      response.writeHead(302, { location: `${path}/`, 'content-length': 0 });
      response.end();
      return 302;
    }
  }
  const fallback = SPA ? INDEX : ERROR;
  const document = await fromStore(method, fallback, {});
  if (document.statusCode === 200) return relay(method, response, document, fallback, SPA ? 200 : 404);
  document.resume();
  const body = '<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>\n';
  response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff' });
  response.end(method === 'HEAD' ? undefined : body);
  return 404;
}

const server = createServer((request, response) => {
  counted.requests++;
  answer(request, response)
    .then((status) => (counted.byStatus[status] = (counted.byStatus[status] ?? 0) + 1))
    .catch((error) => {
      console.error(`request failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(500, { 'content-length': 0 });
      response.end();
    });
});
server.keepAliveTimeout = 5_000;
server.listen(Number(PORT), '127.0.0.1');
const stop = () => {
  console.log(JSON.stringify({ ...counted, rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

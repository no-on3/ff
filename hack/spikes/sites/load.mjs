#!/usr/bin/env node
// The sites spike's checks and measures (the step-4 plan's W-01), against two website servers (a single-page app's and
// a plain site's) and the store directly: what each path answers, then a site's first load as a browser makes it (its
// index, then its assets six at a time), many small files at once, and one large file. One JSON line each.
//   SPA_URL=… SITE_URL=… STORE=… STORE_KEY=… STORE_SECRET=… BUCKET=… ASSETS=30 SMALL=500 node load.mjs
import { Agent, request as httpRequest } from 'node:http';
import { encodeKey, signed } from './sign.mjs';

const { SPA_URL, SITE_URL, STORE, STORE_KEY, STORE_SECRET, BUCKET } = process.env;
const ASSETS = Number(process.env.ASSETS ?? 30);
const SMALL = Number(process.env.SMALL ?? 500);
const RUNS = Number(process.env.RUNS ?? 20);
const store = new URL(STORE);

/** One request, its body read; through the server at `base`, or to the store, signed, when `base` is null. */
function get(base, path, { method = 'GET', headers = {}, agent } = {}) {
  const started = performance.now();
  const target = base ? new URL(base) : store;
  const fullPath = base ? path : `/${BUCKET}/${encodeKey(decodeURIComponent(path).replace(/^\//, ''))}`;
  const sent = base ? headers : signed({ method, host: store.host, path: fullPath, headers, key: STORE_KEY, secret: STORE_SECRET });
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, method, path: fullPath, headers: sent, agent }, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (chunks.length < 4) chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes, body: Buffer.concat(chunks).toString('utf8', 0, 200), ms: performance.now() - started }));
      response.on('error', reject);
    });
    request.once('error', reject);
    request.end();
  });
}

/** Runs the tasks with at most `limit` at once. */
async function limited(tasks, limit) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]();
      }
    }),
  );
  return results;
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10) / 10;
};
const line = (object) => console.log(JSON.stringify(object));
const check = (what, want, got) => line({ check: what, want, got, ok: want === got });

// What each path answers.
const index = await get(SITE_URL, '/');
// The type the AWS CLI gave it, by Python's mimetypes: no charset, kept as S3 keeps it.
check('/ answers the index document, as the AWS CLI typed it', '200 text/html', `${index.status} ${index.headers['content-type']}`);
check('every answer says nosniff', 'nosniff', index.headers['x-content-type-options']);
check("a folder's path answers its index document", 200, (await get(SITE_URL, '/docs/')).status);
const folder = await get(SITE_URL, '/docs');
check('a folder named without its slash is redirected to it', '302 /docs/', `${folder.status} ${folder.headers.location}`);
const missing = await get(SITE_URL, '/no/such/page');
check('a plain site answers an unknown path with its error document', '404 error page', `${missing.status} ${missing.body.includes('error page') ? 'error page' : missing.body.slice(0, 40)}`);
const route = await get(SPA_URL, '/orders/42');
check("a single-page app answers an unknown path with its index document", '200 index', `${route.status} ${route.body.includes('index') ? 'index' : route.body.slice(0, 40)}`);
const asset = await get(SITE_URL, '/assets/app-0.js');
check('an asset keeps its stored type', 'text/javascript', asset.headers['content-type']);
check('a file stored without a type gets one by its name', 'text/css; charset=utf-8', (await get(SITE_URL, '/untyped.css')).headers['content-type']);
check('a file whose ETag the browser has answers 304', 304, (await get(SITE_URL, '/assets/app-0.js', { headers: { 'if-none-match': asset.headers.etag } })).status);
const range = await get(SITE_URL, '/assets/app-0.js', { headers: { range: 'bytes=0-9' } });
check('a range answers 206 with those bytes', '206 10', `${range.status} ${range.bytes}`);
const head = await get(SITE_URL, '/assets/app-0.js', { method: 'HEAD' });
check('HEAD answers the length and no body', `200 ${asset.bytes} 0`, `${head.status} ${head.headers['content-length']} ${head.bytes}`);
check('POST is refused', 405, (await get(SITE_URL, '/', { method: 'POST' })).status);

// Paths with dot segments, sent as written: whether the store resolves them, which would take a key of one bucket to
// another's objects, and what the website server makes of them.
function rawToStore(pathAsSent) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: store.hostname, port: store.port, method: 'GET', path: pathAsSent, headers: signed({ method: 'GET', host: store.host, path: pathAsSent, key: STORE_KEY, secret: STORE_SECRET }) },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(`${response.statusCode} ${Buffer.concat(chunks).toString('utf8').includes('the other bucket') ? 'the other bucket' : 'not it'}`));
      },
    );
    request.once('error', reject);
    request.end();
  });
}
for (const path of [
  `/${BUCKET}/../spike-other/secret.txt`,
  `/${BUCKET}/%2E%2E/spike-other/secret.txt`,
  `/${BUCKET}/..%2Fspike-other%2Fsecret.txt`,
  `/${BUCKET}/./../spike-other/secret.txt`,
]) {
  const answer = await rawToStore(path);
  const got = answer.endsWith('the other bucket') ? 'the other bucket' : 'not the other bucket';
  line({ check: `the store, asked ${path}`, want: 'not the other bucket', got, ok: got === 'not the other bucket', detail: answer });
}
const traversal = await get(SITE_URL, '/../spike-other/secret.txt');
check('the website server, asked /../spike-other/secret.txt', 'not the other bucket', traversal.body.includes('the other bucket') ? 'the other bucket' : 'not the other bucket');

// A first load, as a browser makes it over HTTP/1.1: the index, then its assets, six connections to the host.
async function firstLoad(base) {
  const agent = new Agent({ keepAlive: true, maxSockets: 6 });
  const started = performance.now();
  await get(base, '/', { agent });
  await limited(Array.from({ length: ASSETS }, (_, i) => () => get(base, `/assets/app-${i}.js`, { agent })), 6);
  agent.destroy();
  return performance.now() - started;
}
for (const [via, base] of [['website server', SITE_URL], ['store directly', null]]) {
  await firstLoad(base); // warm
  const times = [];
  for (let run = 0; run < RUNS; run++) times.push(await firstLoad(base));
  line({ measure: 'first load', via, files: ASSETS + 1, runs: RUNS, medianMs: quantile(times, 0.5), p95Ms: quantile(times, 0.95) });
}

// Many small files at once: a busy site's visitors together.
for (const [via, base] of [['website server', SITE_URL], ['store directly', null]]) {
  const agent = new Agent({ keepAlive: true, maxSockets: 50 });
  const started = performance.now();
  const results = await limited(Array.from({ length: SMALL }, (_, i) => () => get(base, `/small/f-${i}.txt`, { agent })), 50);
  const seconds = (performance.now() - started) / 1000;
  agent.destroy();
  const latencies = results.map((result) => result.ms);
  line({
    measure: 'small files, 50 at once',
    via,
    files: SMALL,
    allOk: results.every((result) => result.status === 200),
    perSecond: Math.round(SMALL / seconds),
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    p99Ms: quantile(latencies, 0.99),
  });
}

// One large file, streamed.
for (const [via, base] of [['website server', SITE_URL], ['store directly', null]]) {
  const result = await get(base, '/large.bin');
  line({ measure: 'one large file', via, mb: Math.round(result.bytes / 1048576), mbPerSecond: Math.round(result.bytes / 1048576 / (result.ms / 1000)) });
}

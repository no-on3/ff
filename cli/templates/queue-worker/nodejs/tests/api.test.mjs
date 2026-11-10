// The API, outside its CodeUri so that no package holds it: node --test, from the application's folder. The queue is
// a stand-in that keeps what it is sent and answers each with an ID.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { passTraceOn, route } from '../src/api.mjs';

const event = async (name) => JSON.parse(await readFile(new URL(`../events/${name}`, import.meta.url), 'utf8'));
const request = (method, path, body) => ({ rawPath: path, requestContext: { http: { method, path } }, body });

function standIn() {
  const sent = [];
  return { sent, send: async (body) => (sent.push(JSON.parse(body)), `id-${sent.length}`) };
}

test('POST /jobs puts the job in the queue, as it came, and answers 202 with its ID', async () => {
  const { sent, send } = standIn();

  const answer = await route(await event('post-job.json'), send);

  assert.deepEqual([answer.statusCode, JSON.parse(answer.body)], [202, { id: 'id-1', task: 'greet' }]);
  assert.deepEqual(sent, [{ task: 'greet', name: 'Amira' }]);
});

test('a body in base64 is read as the text it holds', async () => {
  const { sent, send } = standIn();
  const body = Buffer.from('{"task": "greet", "name": "Sami"}').toString('base64');

  const answer = await route({ ...request('POST', '/jobs', body), isBase64Encoded: true }, send);

  assert.deepEqual([answer.statusCode, sent], [202, [{ task: 'greet', name: 'Sami' }]]);
});

test('a job that is no job is refused with 400, nothing sent', async () => {
  const long = JSON.stringify({ task: 'x'.repeat(101) });
  const big = JSON.stringify({ task: 'big', data: 'x'.repeat(262_144) });
  for (const body of ['not json', '[]', '"greet"', '{}', '{"task": ""}', '{"task": 7}', long, big]) {
    const { sent, send } = standIn();

    const answer = await route(request('POST', '/jobs', body), send);

    assert.equal(answer.statusCode, 400, body.slice(0, 40));
    assert.match(JSON.parse(answer.body).message, /JSON|an object|names its task|bytes at most/);
    assert.deepEqual(sent, []);
  }
});

test('a path without a route is 404, and a method /jobs lacks 405 with Allow', async () => {
  const { sent, send } = standIn();

  const none = await route(request('POST', '/orders'), send);
  const wrong = await route(request('GET', '/jobs'), send);

  assert.deepEqual([none.statusCode, JSON.parse(none.body)], [404, { message: 'No route for /orders' }]);
  assert.deepEqual([wrong.statusCode, wrong.headers.allow], [405, 'POST']);
  assert.deepEqual(sent, []);
});

test("the queue's client sends the call's trace in X-Amzn-Trace-Id, read at each request, and keeps one the request has", async () => {
  const added = [];
  const client = { middlewareStack: { add: (middleware, options) => added.push({ middleware, options }) } };
  assert.equal(passTraceOn(client), client);
  const [{ middleware, options }] = added;
  const sent = async (headers) => (await middleware(async (args) => args)({ request: { headers } })).request.headers;
  const before = process.env._X_AMZN_TRACE_ID;
  try {
    process.env._X_AMZN_TRACE_ID = 'Root=1-6912b0a3-5f1e2d3c4b5a69788796a5b4;Parent=53995c3f42cd8ad8;Sampled=0';
    const first = await sent({});
    process.env._X_AMZN_TRACE_ID = 'Root=1-6912b0a4-000000000000000000000001;Parent=0000000000000001;Sampled=0';
    const next = await sent({});
    const kept = await sent({ 'X-Amzn-Trace-Id': 'Root=1-6912b0a3-aaaaaaaaaaaaaaaaaaaaaaaa' });
    delete process.env._X_AMZN_TRACE_ID;
    const none = await sent({});

    assert.deepEqual(options, { step: 'build', name: 'passTraceOn' });
    assert.equal(first['X-Amzn-Trace-Id'], 'Root=1-6912b0a3-5f1e2d3c4b5a69788796a5b4;Parent=53995c3f42cd8ad8;Sampled=0');
    assert.equal(next['X-Amzn-Trace-Id'], 'Root=1-6912b0a4-000000000000000000000001;Parent=0000000000000001;Sampled=0');
    assert.deepEqual(kept, { 'X-Amzn-Trace-Id': 'Root=1-6912b0a3-aaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.deepEqual(none, {});
  } finally {
    if (before === undefined) delete process.env._X_AMZN_TRACE_ID;
    else process.env._X_AMZN_TRACE_ID = before;
  }
});

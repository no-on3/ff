// The API's routes, outside its CodeUri so that no package holds them: node --test, from the application's folder.
// The database is a stand-in that answers each query with the rows it is given, and keeps what it was asked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { route } from '../src/app.mjs';

const event = async (name) => JSON.parse(await readFile(new URL(`../events/${name}`, import.meta.url), 'utf8'));
const request = (method, path, body) => ({
  rawPath: path,
  requestContext: { http: { method, path } },
  body,
  isBase64Encoded: false,
});

function standIn(...answers) {
  const asked = [];
  const db = { query: async (text, values = []) => (asked.push([text.split(' ')[0], values]), answers.shift() ?? []) };
  return { asked, connect: async () => db };
}

const tea = { id: 1, name: 'Harissa, 2 jars', createdAt: '2026-11-09T09:00:00Z' };

test('GET /items lists the latest items', async () => {
  const { asked, connect } = standIn([tea]);
  const answer = await route(await event('list-items.json'), connect);

  assert.deepEqual([answer.statusCode, JSON.parse(answer.body)], [200, [tea]]);
  assert.deepEqual(asked, [['SELECT', []]]);
});

test('POST /items keeps the item and answers 201 with it and its address', async () => {
  const { asked, connect } = standIn([tea]);
  const answer = await route(await event('create-item.json'), connect);

  assert.deepEqual([answer.statusCode, answer.headers.location, JSON.parse(answer.body)], [201, '/items/1', tea]);
  assert.deepEqual(asked, [['INSERT', ['Harissa, 2 jars']]]);
});

test('a body in base64 is read as the text it holds', async () => {
  const { asked, connect } = standIn([tea]);
  const body = Buffer.from('{"name": "  Harissa, 2 jars "}').toString('base64');
  const answer = await route({ ...request('POST', '/items', body), isBase64Encoded: true }, connect);

  assert.deepEqual([answer.statusCode, asked], [201, [['INSERT', ['Harissa, 2 jars']]]]);
});

test('an item that is no item is refused with 400, the database never asked', async () => {
  for (const body of ['not json', '{}', '{"name": ""}', '{"name": 7}', JSON.stringify({ name: 'x'.repeat(201) })]) {
    const { asked, connect } = standIn();
    const answer = await route(request('POST', '/items', body), connect);

    assert.equal(answer.statusCode, 400, body);
    assert.match(JSON.parse(answer.body).message, /JSON|1 to 200 characters/);
    assert.deepEqual(asked, []);
  }
});

test('GET /items/<id> answers the item, or 404', async () => {
  const { asked, connect } = standIn([tea], []);

  const found = await route(request('GET', '/items/1'), connect);
  const missing = await route(request('GET', '/items/2'), connect);

  assert.deepEqual([found.statusCode, JSON.parse(found.body)], [200, tea]);
  assert.deepEqual([missing.statusCode, JSON.parse(missing.body)], [404, { message: 'No item 2' }]);
  assert.deepEqual(asked, [['SELECT', [1]], ['SELECT', [2]]]);
});

test('DELETE /items/<id> answers 204 without a body, or 404', async () => {
  const { connect } = standIn([{ id: 1 }], []);

  const deleted = await route(request('DELETE', '/items/1'), connect);
  const missing = await route(request('DELETE', '/items/1'), connect);

  assert.deepEqual([deleted.statusCode, deleted.body], [204, undefined]);
  assert.equal(missing.statusCode, 404);
});

test('a path without a route is 404, and a method its route lacks 405 with the methods it takes', async () => {
  const { asked, connect } = standIn();

  const none = await route(request('GET', '/orders'), connect);
  const wrong = await route(request('PUT', '/items/1'), connect);

  assert.deepEqual([none.statusCode, JSON.parse(none.body)], [404, { message: 'No route for /orders' }]);
  assert.deepEqual([wrong.statusCode, wrong.headers.allow], [405, 'GET, DELETE']);
  assert.deepEqual(asked, []);
});

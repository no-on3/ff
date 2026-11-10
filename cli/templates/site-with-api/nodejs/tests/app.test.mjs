// The API's routes, outside its CodeUri so that no package holds them: node --test, from the application's folder.
// The bucket is a stand-in that keeps its objects in a Map and lists their keys in order, as a bucket does.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { LATEST, idOf, route } from '../src/app.mjs';

const event = async (name) => JSON.parse(await readFile(new URL(`../events/${name}`, import.meta.url), 'utf8'));
const request = (method, path, body) => ({
  rawPath: path,
  requestContext: { http: { method, path } },
  body,
  isBase64Encoded: false,
});

function standIn(...entries) {
  const objects = new Map(entries.map((entry) => [`entries/${entry.id}.json`, JSON.stringify(entry)]));
  const asked = [];
  const bucket = {
    keys: async (prefix, most) => {
      asked.push(['keys', prefix, most]);
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort().slice(0, most);
    },
    get: async (key) => objects.get(key),
    put: async (key, body) => {
      objects.set(key, body);
    },
  };
  return { asked, bucket, objects };
}

const entry = (date, name, message) => ({ id: idOf(new Date(date), 'cafe0001'), name, message, at: date });

test('GET /entries lists the latest entries, the newest first', async () => {
  const older = entry('2026-11-08T18:00:00.000Z', 'Youssef', 'First!');
  const newer = entry('2026-11-09T09:30:00.000Z', 'Amira', 'Greetings from Sousse');
  const { asked, bucket } = standIn(older, newer);

  const answer = await route(await event('list-entries.json'), bucket);

  assert.deepEqual([answer.statusCode, JSON.parse(answer.body)], [200, [newer, older]]);
  assert.deepEqual(asked, [['keys', 'entries/', LATEST]]);
});

test('POST /entries keeps the entry, trimmed, under its ID, and answers 201 with it', async () => {
  const { bucket, objects } = standIn();
  const before = Date.now();

  const answer = await route(await event('post-entry.json'), bucket);

  const kept = JSON.parse(answer.body);
  assert.equal(answer.statusCode, 201);
  assert.deepEqual([kept.name, kept.message], ['Amira', 'Lovely page, greetings from Sousse!']);
  assert.match(kept.id, /^\d{13}-[0-9a-f]{8}$/);
  assert.ok(Date.parse(kept.at) >= before);
  assert.deepEqual([...objects.keys()], [`entries/${kept.id}.json`]);
  assert.deepEqual(JSON.parse(objects.get(`entries/${kept.id}.json`)), kept);
});

test('a body in base64 is read as the text it holds', async () => {
  const { objects, bucket } = standIn();
  const body = Buffer.from('{"name": "  Salma ", "message": "Ahlan 👋"}').toString('base64');

  const answer = await route({ ...request('POST', '/entries', body), isBase64Encoded: true }, bucket);

  assert.deepEqual([answer.statusCode, JSON.parse(answer.body).name, objects.size], [201, 'Salma', 1]);
});

test('an entry that is no entry is refused with 400, the bucket never written', async () => {
  const bodies = [
    'not json',
    '[]',
    '{"message": "no name"}',
    '{"name": "Amira", "message": "   "}',
    '{"name": 7, "message": "hi"}',
    JSON.stringify({ name: 'x'.repeat(51), message: 'hi' }),
    JSON.stringify({ name: 'Amira', message: '👋'.repeat(501) }),
  ];
  for (const body of bodies) {
    const { bucket, objects } = standIn();
    const answer = await route(request('POST', '/entries', body), bucket);

    assert.equal(answer.statusCode, 400, body);
    assert.match(JSON.parse(answer.body).message, /JSON|object|1 to (50|500) characters/);
    assert.equal(objects.size, 0);
  }
  const { bucket } = standIn();
  const longest = JSON.stringify({ name: 'x'.repeat(50), message: '👋'.repeat(500) });
  assert.equal((await route(request('POST', '/entries', longest), bucket)).statusCode, 201);
});

test('another path is 404; another method 405, with the methods it takes', async () => {
  const { bucket } = standIn();

  const missing = await route(request('GET', '/nowhere'), bucket);
  const deleted = await route(request('DELETE', '/entries'), bucket);

  assert.deepEqual([missing.statusCode, JSON.parse(missing.body).message], [404, 'No route for /nowhere']);
  assert.deepEqual([deleted.statusCode, deleted.headers.allow], [405, 'GET, POST']);
});

test("an entry's ID sorts a later time first, its time counted down in 13 digits", () => {
  const ids = ['2026-11-09T09:30:00.001Z', '2026-11-09T09:30:00.000Z', '2001-01-01T00:00:00.000Z'].map((at) =>
    idOf(new Date(at), '00000000'),
  );

  assert.deepEqual([...ids].sort(), ids);
  assert.equal(ids[2], `${String(9_999_999_999_999 - Date.parse('2001-01-01T00:00:00.000Z'))}-00000000`);
  assert.equal(ids[0].length, 13 + 1 + 8);
});

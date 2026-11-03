// The handler's test, outside its CodeUri so that no package holds it: node --test, from the application's folder.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { lambdaHandler } from '../../hello-world/app.mjs';

test('a function URL request is answered hello world', async () => {
  const event = JSON.parse(await readFile(new URL('../../events/event.json', import.meta.url), 'utf8'));
  const result = await lambdaHandler(event, {});

  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { message: 'hello world' });
});

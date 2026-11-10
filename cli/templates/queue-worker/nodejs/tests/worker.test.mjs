// The worker, outside its CodeUri so that no package holds it: node --test, from the application's folder. Its
// batches are SQS's events, as Lambda gives them.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { TASKS, work } from '../src/worker.mjs';

const batch = async () => JSON.parse(await readFile(new URL('../events/batch.json', import.meta.url), 'utf8'));
const record = (messageId, body) => ({ messageId, body, attributes: { ApproximateReceiveCount: '1' } });

test('each job is done by its task, and a job whose task none does is named failed, alone', async () => {
  const event = await batch();

  const answer = await work(event, TASKS);

  assert.deepEqual(answer, { batchItemFailures: [{ itemIdentifier: event.Records[1].messageId }] });
});

test('a batch done whole names none', async () => {
  const done = [];
  const tasks = { greet: async (job) => done.push(job.name) };

  const records = [record('a', '{"task": "greet", "name": "Amira"}'), record('b', '{"task": "greet", "name": "Sami"}')];

  const answer = await work({ Records: records }, tasks);

  assert.deepEqual([answer, done], [{ batchItemFailures: [] }, ['Amira', 'Sami']]);
});

test('a task that throws fails its job alone, and the jobs after it are done', async () => {
  const done = [];
  const tasks = {
    greet: async (job) => {
      if (!job.name) throw new Error('A greeting needs a name');
      done.push(job.name);
    },
  };
  const records = [
    record('a', '{"task": "greet"}'),
    record('b', 'not json'),
    record('c', '{"task": "greet", "name": "Sami"}'),
  ];

  const answer = await work({ Records: records }, tasks);

  assert.deepEqual(answer.batchItemFailures, [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }]);
  assert.deepEqual(done, ['Sami']);
});

test("a task's name is one of the tasks' own, never an object's property", async () => {
  const records = [record('a', '{"task": "constructor"}'), record('b', '{"task": "toString"}')];

  const answer = await work({ Records: records }, TASKS);

  assert.equal(answer.batchItemFailures.length, 2);
});

test('greet greets the name it is given, and needs one', async () => {
  assert.equal(await TASKS.greet({ task: 'greet', name: 'Amira' }), 'Hello Amira');
  await assert.rejects(TASKS.greet({ task: 'greet' }), /needs a name/);
});

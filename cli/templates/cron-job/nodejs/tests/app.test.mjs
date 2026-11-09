// The job's report, outside its CodeUri so that no package holds it: node --test, from the application's folder.
// The bucket is a stand-in that lists the files it is given, and keeps what the job writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { report } from '../src/app.mjs';

const scheduled = async () =>
  JSON.parse(await readFile(new URL('../events/scheduled.json', import.meta.url), 'utf8'));

function standIn(...files) {
  const listed = [];
  const written = {};
  const bucket = {
    list: async (prefix) => (listed.push(prefix), files.filter((file) => file.key.startsWith(prefix))),
    put: async (key, body) => {
      written[key] = JSON.parse(body);
    },
  };
  return { bucket, listed, written };
}

const file = (key, size, lastModified) => ({ key, size, lastModified });

test("the schedule's run reports the day before its time, the files that arrived under incoming/", async () => {
  const { bucket, listed, written } = standIn(
    file('incoming/late.csv', 300, '2026-11-08T23:59:59.000Z'),
    file('incoming/orders.csv', 1200, '2026-11-09T08:15:00.000Z'),
    file('incoming/photo.jpg', 5000, '2026-11-09T17:40:00.000Z'),
    file('incoming/early.csv', 70, '2026-11-10T00:00:01.000Z'),
    file('reports/2026-11-08.json', 90, '2026-11-09T06:00:02.000Z'),
  );

  const summary = await report(await scheduled(), bucket);

  const expected = { day: '2026-11-09', files: 2, bytes: 6200, largest: { key: 'incoming/photo.jpg', size: 5000 } };
  assert.deepEqual(summary, expected);
  assert.deepEqual(written, { 'reports/2026-11-09.json': expected });
  assert.deepEqual(listed, ['incoming/']);
});

test('a day without files is reported too, as none', async () => {
  const { bucket, written } = standIn();

  await report(await scheduled(), bucket);

  assert.deepEqual(written['reports/2026-11-09.json'], { day: '2026-11-09', files: 0, bytes: 0, largest: null });
});

test("the day is UTC's: a run at 00:30 in Tunis is the day before's in UTC", async () => {
  const { bucket } = standIn();

  const summary = await report({ ...(await scheduled()), time: '2026-11-10T00:30:00+01:00' }, bucket);

  assert.equal(summary.day, '2026-11-08');
});

test('a run by hand reports the day it names', async () => {
  const { bucket, written } = standIn(file('incoming/today.txt', 12, '2026-11-10T09:00:00.000Z'));

  await report({ day: '2026-11-10' }, bucket);

  assert.equal(written['reports/2026-11-10.json'].files, 1);
});

test('without a time, it reports yesterday', async () => {
  const { bucket } = standIn();

  const summary = await report({}, bucket);

  assert.equal(summary.day, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10));
});

test('an event whose time or day is no date fails the run, nothing written, so that it is tried again', async () => {
  for (const event of [{ time: 'yesterday' }, { day: '2026-13-01' }, { day: '9 November' }, { day: 20261109 }]) {
    const { bucket, listed, written } = standIn();

    await assert.rejects(report(event, bucket), /time is no date|YYYY-MM-DD/, JSON.stringify(event));
    assert.deepEqual([listed, written], [[], {}]);
  }
});

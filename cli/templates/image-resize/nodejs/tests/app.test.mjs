// The thumbnails, outside the CodeUri so that no package holds them: node --test, from the application's folder.
// The bucket is a stand-in that keeps its files in a Map, and the resize one that marks the bytes it is given, so
// that the tests need neither the bucket nor sharp.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { thumbnailOf, thumbnails } from '../src/app.mjs';

const upload = async () => JSON.parse(await readFile(new URL('../events/upload.json', import.meta.url), 'utf8'));
const record = (bucket, key) => ({ s3: { bucket: { name: bucket }, object: { key } } });

function standIn(files) {
  const read = [];
  const written = {};
  const bucket = {
    get: async (name, key) => (read.push(`${name}/${key}`), files[`${name}/${key}`]),
    put: async (name, key, body, type) => {
      written[`${name}/${key}`] = [body.toString(), type];
    },
  };
  return { bucket, read, written };
}
const resize = async (image) => {
  if (!image.toString().startsWith('image:')) throw new Error('Input buffer contains unsupported image format');
  return Buffer.from(`small ${image}`);
};

test("an upload makes its thumbnail in the event's bucket, under thumbnails/, its key read as put", async () => {
  const event = await upload();
  const bucket = event.Records[0].s3.bucket.name;
  const image = { [`${bucket}/uploads/Sidi Bou Saïd.jpg`]: Buffer.from('image:sea') };
  const { bucket: files, read, written } = standIn(image);

  const made = await thumbnails(event, files, resize);

  assert.deepEqual(made, { made: ['thumbnails/Sidi Bou Saïd.webp'] });
  assert.deepEqual(read, [`${bucket}/uploads/Sidi Bou Saïd.jpg`]);
  assert.deepEqual(written, { [`${bucket}/thumbnails/Sidi Bou Saïd.webp`]: ['small image:sea', 'image/webp'] });
});

test('each record of the event is made, in its order', async () => {
  const { bucket, written } = standIn({
    'b/uploads/a.png': Buffer.from('image:a'),
    'b/uploads/2026/b.gif': Buffer.from('image:b'),
  });
  const event = { Records: [record('b', 'uploads/a.png'), record('b', 'uploads/2026/b.gif')] };

  const made = await thumbnails(event, bucket, resize);

  assert.deepEqual(made.made, ['thumbnails/a.webp', 'thumbnails/2026/b.webp']);
  assert.deepEqual(Object.keys(written), ['b/thumbnails/a.webp', 'b/thumbnails/2026/b.webp']);
});

test('a file that is no image is left, nothing written and no error, as trying again would fail again', async () => {
  const { bucket, written } = standIn({ 'b/uploads/notes.txt': Buffer.from('notes') });

  assert.deepEqual(await thumbnails({ Records: [record('b', 'uploads/notes.txt')] }, bucket, resize), { made: [] });
  assert.deepEqual(written, {});
});

test('a key outside uploads/, a thumbnail among them, is left unread', async () => {
  const { bucket, read, written } = standIn({});
  const keys = ['thumbnails/a.webp', 'a.png', 'uploads/', 'uploads/2026/'];

  const made = await thumbnails({ Records: keys.map((key) => record('b', key)) }, bucket, resize);

  assert.deepEqual([made.made, read, written], [[], [], {}]);
});

test('an error of the bucket fails the call, so that it is tried again', async () => {
  const { bucket } = standIn({});
  bucket.get = async () => {
    throw new Error('SlowDown');
  };

  await assert.rejects(thumbnails({ Records: [record('b', 'uploads/a.png')] }, bucket, resize), /SlowDown/);
});

test("a thumbnail's key: the upload's path under thumbnails/, its extension .webp", () => {
  const keys = {
    'uploads/a.png': 'thumbnails/a.webp',
    'uploads/a': 'thumbnails/a.webp',
    'uploads/a.tar.gz': 'thumbnails/a.tar.webp',
    'uploads/.hidden': 'thumbnails/.hidden.webp',
    'uploads/v1.2/a': 'thumbnails/v1.2/a.webp',
    'uploads/uploads/a.jpeg': 'thumbnails/uploads/a.webp',
  };

  assert.deepEqual(Object.fromEntries(Object.keys(keys).map((key) => [key, thumbnailOf(key)])), keys);
});

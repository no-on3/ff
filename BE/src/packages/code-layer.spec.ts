import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildLayer } from './code-layer';
import { TestEntry, zipOf } from './test-fixtures';

/** A tar's entries as a reader sees them: PAX paths applied. */
function entries(tar: Buffer): Array<{ name: string; mode: number; uid: number; gid: number; type: string; mtime: number; data: string }> {
  const read: ReturnType<typeof entries> = [];
  let pathOverride: string | undefined;
  for (let at = 0; at + 512 <= tar.length; ) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pathOverride = /\d+ path=(.*)\n/.exec(data.toString('utf8'))?.[1];
      continue;
    }
    // The header's own checksum, as tar readers check it.
    const unsigned = [...block].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    expect(parseInt(field(148, 8), 8)).toBe(unsigned);
    read.push({
      name: pathOverride ?? field(0, 100),
      mode: parseInt(field(100, 8), 8),
      uid: parseInt(field(108, 8), 8),
      gid: parseInt(field(116, 8), 8),
      type,
      mtime: parseInt(field(136, 12), 8),
      data: data.toString('utf8'),
    });
    pathOverride = undefined;
  }
  return read;
}

describe("a package's code layer, as its image holds it", () => {
  let dir: string;
  let n = 0;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-layer-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const layerOf = async (zipEntries: TestEntry[]) => {
    const zip = join(dir, `${++n}.zip`);
    const layer = join(dir, `${n}.tar.gz`);
    writeFileSync(zip, zipOf(zipEntries));
    const built = await buildLayer(zip, layer);
    return { built, bytes: readFileSync(layer) };
  };

  const PACKAGE: TestEntry[] = [
    { name: 'src/app.js', data: 'exports.handler = async () => 1;\n' },
    { name: 'node_modules/.bin/tool', data: '#!/bin/sh\necho tool\n', mode: 0o100755 },
    { name: 'node_modules/left-pad/index.js', data: 'module.exports = (s) => s;\n', method: 0 },
    { name: 'package.json', data: '{}' },
  ];

  it("holds the package's files at its root, folders first, owned by root, read-only, at the epoch, executables kept so", async () => {
    const { bytes } = await layerOf(PACKAGE);

    expect(entries(gunzipSync(bytes))).toEqual([
      { name: 'node_modules/', mode: 0o555, uid: 0, gid: 0, type: '5', mtime: 0, data: '' },
      { name: 'node_modules/.bin/', mode: 0o555, uid: 0, gid: 0, type: '5', mtime: 0, data: '' },
      { name: 'node_modules/.bin/tool', mode: 0o555, uid: 0, gid: 0, type: '0', mtime: 0, data: '#!/bin/sh\necho tool\n' },
      { name: 'node_modules/left-pad/', mode: 0o555, uid: 0, gid: 0, type: '5', mtime: 0, data: '' },
      { name: 'node_modules/left-pad/index.js', mode: 0o444, uid: 0, gid: 0, type: '0', mtime: 0, data: 'module.exports = (s) => s;\n' },
      { name: 'package.json', mode: 0o444, uid: 0, gid: 0, type: '0', mtime: 0, data: '{}' },
      { name: 'src/', mode: 0o555, uid: 0, gid: 0, type: '5', mtime: 0, data: '' },
      { name: 'src/app.js', mode: 0o444, uid: 0, gid: 0, type: '0', mtime: 0, data: 'exports.handler = async () => 1;\n' },
    ]);
  });

  it('is the same, byte for byte, from the same package however its zip is ordered, and says its digests', async () => {
    const first = await layerOf(PACKAGE);
    const again = await layerOf([...PACKAGE].reverse());

    expect(again.bytes.equals(first.bytes)).toBe(true);
    expect(first.built).toEqual({
      digest: `sha256:${createHash('sha256').update(first.bytes).digest('hex')}`,
      size: first.bytes.length,
      diffId: `sha256:${createHash('sha256').update(gunzipSync(first.bytes)).digest('hex')}`,
    });
  });

  it('keeps a name longer than ustar holds, or outside ASCII, whole, in a PAX header', async () => {
    const long = `node_modules/${'very-long-package-name/'.repeat(6)}index.js`;
    const { bytes } = await layerOf([
      { name: long, data: 'deep' },
      { name: 'é.js', data: 'accent' },
    ]);

    const files = entries(gunzipSync(bytes)).filter((entry) => entry.type === '0');
    expect(long.length).toBeGreaterThan(100);
    expect(files.map((file) => [file.name, file.data])).toEqual([
      [long, 'deep'],
      ['é.js', 'accent'],
    ]);
  });

  it('ends on two empty blocks, every entry on a block', async () => {
    const tar = gunzipSync((await layerOf([{ name: 'a.js', data: 'x'.repeat(700) }])).bytes);

    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
  });
});

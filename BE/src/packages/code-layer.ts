import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path/posix';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Entry, ZipFile, openPromise } from 'yauzl';

/**
 * A package's code as a container image's layer (ADR 0003): its files at the
 * layer's root, which an image volume mounts at /var/task. Owned by root and
 * read-only: 0444, and 0555 for folders and for the files a Unix zip tool
 * marked executable. At the epoch, in the order of their names, compressed the
 * same way each time: the same package makes the same layer, byte for byte, so
 * that its image is pushed once.
 */
export interface CodeLayer {
  /** Its digest: the SHA-256 of the compressed bytes, which the manifest names. */
  digest: string;
  /** Its size, compressed. */
  size: number;
  /** The SHA-256 of the tar itself, uncompressed: the image configuration's diff_id. */
  diffId: string;
}

const BLOCK = 512;

/** A number in a tar header: octal, zero-padded, NUL-terminated, in a field of `width` bytes. */
const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0') + '\0';

/** One PAX record, "<length> <key>=<value>\n", its length counting its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length++;
  return `${length}${body}`;
}

/** The padding that ends `size` bytes of data on a block. */
const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** A ustar header: a name that fits, or a PAX header before it that holds the name. */
function header(name: string, mode: number, size: number, type: '0' | '5' | 'x'): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(mode, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.write(' '.repeat(8), 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** The headers of an entry: its name in a PAX header first when ustar's 100 bytes of ASCII can't hold it. */
function headers(name: string, mode: number, size: number, type: '0' | '5'): Buffer[] {
  if (Buffer.byteLength(name) <= 100 && /^[\x20-\x7e]*$/.test(name)) return [header(name, mode, size, type)];
  const pax = Buffer.from(paxRecord('path', name), 'utf8');
  return [header('PaxHeader', 0o444, pax.length, 'x'), pax, padding(pax.length), header(name.slice(0, 100), mode, size, type)];
}

/** Whether a Unix zip tool marked the entry executable. */
const isExecutable = (entry: Entry): boolean => entry.versionMadeBy >> 8 === 3 && ((entry.externalFileAttributes >>> 16) & 0o111) !== 0;

/** The tar of the package's files, a block at a time: folders 0555 before what they hold, files 0444 or 0555. */
async function* tar(zip: ZipFile): AsyncGenerator<Buffer> {
  const files = new Map<string, Entry>();
  const folders = new Set<string>();
  for await (const entry of zip.eachEntry()) {
    const name = path.normalize(entry.fileName).replace(/\/$/, '');
    if (name === '.') continue;
    if (entry.fileName.endsWith('/')) folders.add(name);
    else files.set(name, entry);
    for (let folder = path.dirname(name); folder !== '.'; folder = path.dirname(folder)) folders.add(folder);
  }
  const names = [...folders, ...files.keys()].sort();
  for (const name of names) {
    const entry = files.get(name);
    if (!entry) {
      yield* headers(`${name}/`, 0o555, 0, '5');
      continue;
    }
    yield* headers(name, isExecutable(entry) ? 0o555 : 0o444, entry.uncompressedSize, '0');
    for await (const chunk of (await zip.openReadStreamPromise(entry)) as AsyncIterable<Buffer>) yield chunk;
    yield padding(entry.uncompressedSize);
  }
  yield Buffer.alloc(2 * BLOCK);
}

/** A stream that passes bytes through, hashing and counting them. */
function measured(): { stream: Transform; digest: () => string; size: () => number } {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, digest: () => `sha256:${hash.digest('hex')}`, size: () => size };
}

/**
 * Writes the layer of the package in `zipFile` to `layerFile`, and says its
 * digest, its size and its diff_id. The package was checked when it was
 * uploaded (package-archive.ts); yauzl still checks each file's size here.
 */
export async function buildLayer(zipFile: string, layerFile: string): Promise<CodeLayer> {
  const zip = await openPromise(zipFile, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
  try {
    const uncompressed = measured();
    const compressed = measured();
    await pipeline(Readable.from(tar(zip)), uncompressed.stream, createGzip({ level: 6 }), compressed.stream, createWriteStream(layerFile, { mode: 0o600 }));
    return { digest: compressed.digest(), size: compressed.size(), diffId: uncompressed.digest() };
  } finally {
    zip.close();
  }
}

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_LIMITS, PackageLimits, PackageRefused, readPackage } from './package-archive';
import { TestEntry, zipOf } from './test-fixtures';

describe("a function's package, as FF reads it", () => {
  let dir: string;
  let n = 0;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-package-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The bytes as a file, as an upload leaves them. */
  const file = (bytes: Buffer): string => {
    const path = join(dir, `${++n}.zip`);
    writeFileSync(path, bytes);
    return path;
  };
  const read = (entries: TestEntry[], limits?: PackageLimits) => readPackage(file(zipOf(entries)), limits);
  /** Why it is refused. */
  const refusal = async (entries: TestEntry[] | Buffer, limits?: PackageLimits): Promise<string> => {
    const error = await (Buffer.isBuffer(entries) ? readPackage(file(entries), limits) : read(entries, limits)).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PackageRefused);
    return (error as Error).message;
  };

  it('says which files it holds, sorted, and their size unpacked: a Node.js function with its node_modules', async () => {
    const contents = await read([
      { name: 'src/', mode: 0o040755 },
      { name: 'src/app.js', data: 'exports.handler = async () => 1;\n' },
      { name: 'node_modules/left-pad/index.js', data: 'module.exports = (s) => s;\n', method: 0 },
      { name: 'node_modules/.bin/tool', data: '#!/bin/sh\n', mode: 0o100755 },
      // "./" folders, as some tools write them, mean nothing.
      { name: './package.json', data: '{}' },
    ]);

    expect(contents).toEqual({
      files: ['node_modules/.bin/tool', 'node_modules/left-pad/index.js', 'package.json', 'src/app.js'],
      unpackedSize: 33 + 27 + 10 + 2,
    });
  });

  it('takes a zip made on Windows, whose entries have no Unix mode', async () => {
    expect(await read([{ name: 'lambda_function.py', data: 'def lambda_handler(e, c): return 1\n', mode: 0 }])).toMatchObject({
      files: ['lambda_function.py'],
    });
  });

  describe('refuses a name that would leave the package, or that a file system can\'t hold', () => {
    it.each([
      ['../app.js', '../app.js leaves the package with ..'],
      ['src/../../etc/passwd', 'src/../../etc/passwd leaves the package with ..'],
      ['/etc/passwd', "/etc/passwd is an absolute path: a package's names start at its root"],
      ['src\\app.js', "src\\app.js has a backslash: a zip's folders are separated by /"],
      ['src//app.js', '"src//app.js" has an empty folder name (//) in it'],
      ['app\u0000.js', '"app\\u0000.js" has a NUL character in its name'],
      [`${'x'.repeat(256)}.js`, 'has a name over 255 bytes, the longest a file system takes'],
    ])('%s', async (name, message) => {
      expect(await refusal([{ name, data: 'x' }])).toContain(message);
    });
  });

  it('refuses a symbolic link, which could point out of the package', async () => {
    expect(await refusal([{ name: 'secrets', data: '/etc/shadow', mode: 0o120777 }])).toBe(
      'secrets is a symbolic link: a package holds files and folders only',
    );
  });

  it('refuses a file twice, even under two spellings of its name', async () => {
    expect(await refusal([{ name: 'app.js', data: '1' }, { name: './app.js', data: '2' }])).toBe('app.js is in the package twice');
  });

  it('refuses a name that is a file and a folder', async () => {
    expect(await refusal([{ name: 'src', data: 'x' }, { name: 'src/app.js', data: 'y' }])).toBe('src is a file and a folder of the package');
  });

  it('refuses what it would have to decrypt, or unpack with another method than deflate', async () => {
    expect(await refusal([{ name: 'app.js', data: 'x', flags: 0x1 }])).toBe("app.js is encrypted: a package's files are read as they are");
    expect(await refusal([{ name: 'app.js', data: 'x', method: 12 }])).toBe(
      "app.js is packed with method 12: a package's files are stored or deflated, as zip tools do",
    );
  });

  it("refuses bytes that don't match their checksum, or a size that lies, as a bomb's header would", async () => {
    expect(await refusal([{ name: 'app.js', data: 'exports.handler = 1', crc32: 1234 }])).toBe("app.js is damaged: its bytes don't match its checksum");
    expect(await refusal([{ name: 'app.js', data: 'x'.repeat(5000), uncompressedSize: 100 }])).toMatch(/^app\.js is damaged: too many bytes in the stream/);
    expect(await refusal([{ name: 'app.js', data: 'x'.repeat(50), uncompressedSize: 5000 }])).toMatch(/^app\.js is damaged: not enough bytes in the stream/);
  });

  it('refuses a file packed more than 1,000 times over, as zip bombs are, once it is large enough for that to mean something', async () => {
    const zeros = Buffer.alloc(2 * 1024 * 1024);

    expect(await refusal([{ name: 'zeros.bin', data: zeros }])).toBe('zeros.bin is packed more than 1,000 times over, as zip bombs are');
    // The same ratio in a small file is a small file.
    expect(await read([{ name: 'zeros.bin', data: Buffer.alloc(512 * 1024) }])).toMatchObject({ unpackedSize: 512 * 1024 });
  });

  it("refuses more than Lambda's 250 MB unpacked, by what the headers say before anything is unpacked", async () => {
    const limits = { ...PACKAGE_LIMITS, unpackedBytes: 1000 };
    // The headers say so before any byte is read: a header that lies is caught by the bytes, above.
    expect(await refusal([{ name: 'a.bin', data: randomBytes(600) }, { name: 'b.bin', data: randomBytes(600) }], limits)).toBe(
      'The package is over 1,000 bytes unpacked, as AWS Lambda allows (250 MB)',
    );
    expect(PACKAGE_LIMITS.unpackedBytes).toBe(262_144_000);
    expect(PACKAGE_LIMITS.zipBytes).toBe(52_428_800);
  });

  it('refuses more than 20,000 files, and an archive of more entries than it reads', async () => {
    const many = Array.from({ length: 20_001 }, (_, i): TestEntry => ({ name: `f/${i}.js`, data: '', method: 0 }));

    expect(await refusal(many)).toBe('The package has more than 20,000 files');
    expect(await refusal(many.slice(0, 11), { ...PACKAGE_LIMITS, entries: 10 })).toBe(
      'The package has 11 entries: 10 at most, files and folders together',
    );
  });

  it('refuses a package without a file, and what is no zip archive', async () => {
    expect(await refusal([])).toBe("The package has no file: zip the function's folder, its handler's file at the root");
    expect(await refusal([{ name: 'src/' }])).toBe("The package has no file: zip the function's folder, its handler's file at the root");
    expect(await refusal(Buffer.from('exports.handler = async () => 1;'))).toMatch(/^The package isn't a zip archive FF can read: /);
    const whole = zipOf([{ name: 'app.js', data: randomBytes(4096) }]);
    expect(await refusal(whole.subarray(0, whole.length / 2))).toMatch(/^The package isn't a zip archive FF can read: /);
  });

  it('refuses deflated bytes that are no deflate stream', async () => {
    const entry: TestEntry = { name: 'app.js', data: randomBytes(64), method: 0 };
    const zip = zipOf([entry]);
    // Say deflate in both headers, over bytes that were stored.
    zip.writeUInt16LE(8, 8);
    zip.writeUInt16LE(8, 30 + 6 + 64 + 10);

    expect(await refusal(zip)).toMatch(/^app\.js is damaged: /);
  });
});

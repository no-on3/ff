import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage } from '../packages/package-archive';
import { Runtime } from './entities/function.entity';
import { inlinePackage } from './inline-package';

describe('inline code as a package', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-inline-package-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const CODE = "export async function handler() {\n  return 'Ahlan, Sfax';\n}\n";

  it('is a zip of its one file, which the upload checks read back, every byte and its checksum', async () => {
    const built = inlinePackage(CODE, Runtime.NODEJS);
    const file = join(dir, 'node.zip');
    writeFileSync(file, built.zip);

    const contents = await readPackage(file);

    expect(contents).toMatchObject({ files: ['function.ts'], unpackedSize: Buffer.byteLength(CODE) });
    expect(built).toMatchObject({ file: 'function.ts', unpackedSize: Buffer.byteLength(CODE) });
    expect(built.codeSha256).toBe(createHash('sha256').update(built.zip).digest('base64'));
  });

  it("names Python's file for Python, and keeps a name and code outside ASCII", async () => {
    const code = 'def handler(event, context):\n    return "Ahlan, Médenine"\n';
    const built = inlinePackage(code, Runtime.PYTHON);
    const file = join(dir, 'python.zip');
    writeFileSync(file, built.zip);

    expect(await readPackage(file)).toMatchObject({ files: ['function.py'], unpackedSize: Buffer.byteLength(code) });
  });

  it('is the same bytes for the same code, and other bytes for any change, the runtime included', () => {
    const once = inlinePackage(CODE, Runtime.NODEJS);
    const again = inlinePackage(CODE, Runtime.NODEJS);

    expect(again.zip.equals(once.zip)).toBe(true);
    expect(inlinePackage(`${CODE} `, Runtime.NODEJS).codeSha256).not.toBe(once.codeSha256);
    expect(inlinePackage(CODE, Runtime.PYTHON).codeSha256).not.toBe(once.codeSha256);
  });

  it('stores the file, dated 1980-01-01, a regular file 0644', () => {
    const { zip } = inlinePackage(CODE, Runtime.NODEJS);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));

    expect([zip.readUInt16LE(central + 10), zip.readUInt16LE(central + 14), zip.readUInt32LE(central + 38) >>> 16]).toEqual([0, 0x21, 0o100644]);
  });

  it('holds empty code too, an empty file, which the runtime then refuses to load, as it would inline', async () => {
    const file = join(dir, 'empty.zip');
    writeFileSync(file, inlinePackage('', Runtime.NODEJS).zip);

    await expect(readPackage(file)).resolves.toMatchObject({ files: ['function.ts'], unpackedSize: 0 });
  });
});

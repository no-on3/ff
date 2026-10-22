import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { codeFileName } from './code-package';
import { Runtime } from './entities/function.entity';

/**
 * Inline code as the package its pods run (ADR 0003): a zip of its one file,
 * `function.ts` or `function.py`, as AWS Lambda takes one, whose code image is
 * made as an uploaded package's is. The same code makes the same bytes, so the
 * same SHA-256 and the same image: the file stored, not compressed, so that no
 * compression library's version changes a byte; dated 1980-01-01, the earliest
 * a zip holds; a regular file, 0644; its name in UTF-8.
 */
export interface InlinePackage {
  zip: Buffer;
  /** The zip's SHA-256 in base64, which names it as a package: not the code's, which the function's record gives. */
  codeSha256: string;
  file: string;
  unpackedSize: number;
}

const DOS_DATE = (1 << 5) | 1; // 1980-01-01; the time is 00:00
const UTF8_NAMES = 0x0800;
const MADE_ON_UNIX = (3 << 8) | 20; // so that the external attributes hold a Unix mode
const NEEDS = 20;
const REGULAR_FILE_0644 = 0o100644 * 0x10000;

export function inlinePackage(code: string, runtime: Runtime): InlinePackage {
  const file = codeFileName(runtime);
  const name = Buffer.from(file, 'utf8');
  const data = Buffer.from(code, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(NEEDS, 4);
  local.writeUInt16LE(UTF8_NAMES, 6);
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(MADE_ON_UNIX, 4);
  central.writeUInt16LE(NEEDS, 6);
  central.writeUInt16LE(UTF8_NAMES, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // Extra field, comment, disk and internal attributes are 0, as alloc left them.
  central.writeUInt32LE(REGULAR_FILE_0644, 38);
  central.writeUInt32LE(0, 42); // the local header's offset

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);

  const zip = Buffer.concat([local, name, data, central, name, end]);
  return { zip, codeSha256: createHash('sha256').update(zip).digest('base64'), file, unpackedSize: data.length };
}

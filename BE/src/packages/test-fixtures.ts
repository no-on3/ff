// Shared by the packages' tests (not part of the build: tsconfig.build.json
// excludes test-fixtures.ts): a zip archive written byte by byte, which can be
// what no zip tool makes, a name with .., a link, a size or a checksum that lies.
import { crc32, deflateRawSync } from 'node:zlib';

export interface TestEntry {
  /** As the archive names it: a folder's ends with /. */
  name: string;
  /** A file's bytes; none for a folder. */
  data?: Buffer | string;
  /** Stored (0) or deflated (8, the default); any other number is written as it is, with the bytes stored. */
  method?: number;
  /** Unix mode and file type, as a Unix zip tool writes them: a file 0o100644 by default, a folder 0o040755. */
  mode?: number;
  /** What the headers say, when a test wants them to lie. */
  uncompressedSize?: number;
  crc32?: number;
  /** General purpose flags beyond UTF-8 names: 0x1 says encrypted. */
  flags?: number;
}

/** The archive of these entries, in this order, its names in UTF-8. */
export function zipOf(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const isFolder = entry.name.endsWith('/');
    const data = Buffer.from(entry.data ?? '');
    const method = isFolder ? 0 : (entry.method ?? 8);
    const packed = method === 8 ? deflateRawSync(data) : data;
    const checksum = entry.crc32 ?? crc32(data);
    const size = entry.uncompressedSize ?? data.length;
    const flags = 0x800 | (entry.flags ?? 0);
    const mode = entry.mode ?? (isFolder ? 0o040755 : 0o100644);
    // Fixed time and date: 1980-01-01 00:00.
    const time = 0;
    const date = (0 << 9) | (1 << 5) | 1;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    // Made on Unix (3), so that the external attributes hold a Unix mode.
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(checksum >>> 0, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}

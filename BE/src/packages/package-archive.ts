import * as path from 'node:path/posix';
import { crc32 } from 'node:zlib';
import { Entry, ZipFile, openPromise } from 'yauzl';

/**
 * What a package may be, as AWS Lambda's limits say for one uploaded directly:
 * 50 MB as a zip, 250 MB unpacked; and 20,000 files, more than a function with
 * its node_modules has.
 */
export const PACKAGE_LIMITS = {
  zipBytes: 50 * 1024 * 1024,
  unpackedBytes: 250 * 1024 * 1024,
  files: 20_000,
  /** Folders' entries too: a bound on the work before the files are counted. */
  entries: 40_000,
  /**
   * Deflate packs at most about 1,032 bytes into one: a file packed more than
   * 1,000 times over is one byte repeated, as zip bombs are made. Smaller than
   * `ratioFloor`, a file's ratio says nothing.
   */
  ratio: 1_000,
  ratioFloor: 1024 * 1024,
};
export type PackageLimits = typeof PACKAGE_LIMITS;

/** Why a package can't be taken: the caller's mistake, which the API answers with 400. */
export class PackageRefused extends Error {}

/** What a package holds. */
export interface PackageContents {
  /** Its files' paths from its root, sorted: what a handler is looked for in. */
  files: string[];
  /** Its files' sizes together, unpacked. */
  unpackedSize: number;
}

const bytes = (n: number): string => n.toLocaleString('en-US');

/** A name's problem that yauzl leaves to us, or nothing: what a file system and a container image can't hold. */
function nameProblem(name: string): string | undefined {
  if (name.includes('\0')) return 'has a NUL character in its name';
  if (Buffer.byteLength(name, 'utf8') > 4096) return 'has a name over 4,096 bytes, the longest path Linux takes';
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => part === '')) return 'has an empty folder name (//) in it';
  if (parts.some((part) => Buffer.byteLength(part, 'utf8') > 255)) return 'has a name over 255 bytes, the longest a file system takes';
  return undefined;
}

/** yauzl's refusals of a name, in our words; anything else as yauzl says it. */
function describeZipError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const named = /^(absolute path|invalid relative path|invalid characters in fileName): (.*)$/.exec(message);
  if (!named) return message;
  const [, kind, name] = named;
  if (kind === 'absolute path') return `${name} is an absolute path: a package's names start at its root`;
  if (kind === 'invalid relative path') return `${name} leaves the package with ..: a package's names stay inside it`;
  return `${name} has a backslash: a zip's folders are separated by /`;
}

/** The entry's Unix file type, from the attributes a Unix zip tool writes. */
const fileType = (entry: Entry): number => ((entry.externalFileAttributes >>> 16) & 0o170000);
const SYMLINK = 0o120000;

/**
 * Reads every byte of a file of the package, and checks them against its size,
 * as yauzl does, so that a header can't hide a bomb, and its checksum, which
 * yauzl leaves to us. Answers its size.
 */
async function check(zip: ZipFile, entry: Entry, name: string): Promise<number> {
  let checksum = 0;
  let size = 0;
  try {
    const stream = await zip.openReadStreamPromise(entry);
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      checksum = crc32(chunk, checksum);
      size += chunk.length;
    }
  } catch (error) {
    throw new PackageRefused(`${name} is damaged: ${describeZipError(error)}`);
  }
  if (checksum !== entry.crc32) throw new PackageRefused(`${name} is damaged: its bytes don't match its checksum`);
  return size;
}

/**
 * Reads the zip at `file` as a function's package, and says what it holds, or
 * why it is refused (PackageRefused): each name a path inside the package, no
 * link, nothing encrypted, stored or deflated only, every file once, within the
 * limits, and every byte as the headers and the checksums say. Each file is
 * unpacked once, and its bytes thrown away as they come.
 */
export async function readPackage(file: string, limits: PackageLimits = PACKAGE_LIMITS): Promise<PackageContents> {
  let zip: ZipFile;
  try {
    zip = await openPromise(file, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
  } catch (error) {
    throw new PackageRefused(`The package isn't a zip archive FF can read: ${describeZipError(error)}`);
  }
  try {
    if (zip.entryCount > limits.entries) {
      throw new PackageRefused(`The package has ${bytes(zip.entryCount)} entries: ${bytes(limits.entries)} at most, files and folders together`);
    }
    const names = new Set<string>();
    const files: string[] = [];
    let declared = 0;
    let unpackedSize = 0;
    for await (const entry of zip.eachEntry()) {
      const problem = nameProblem(entry.fileName);
      if (problem) throw new PackageRefused(`${JSON.stringify(entry.fileName)} ${problem}`);
      const isFolder = entry.fileName.endsWith('/');
      // "./src/app.js" is src/app.js: a name's own . folders mean nothing.
      const name = path.normalize(entry.fileName).replace(/\/$/, '');
      if (name === '.' && isFolder) continue;
      if (names.has(name)) throw new PackageRefused(`${name} is in the package twice`);
      names.add(name);
      if (entry.isEncrypted()) throw new PackageRefused(`${name} is encrypted: a package's files are read as they are`);
      if (fileType(entry) === SYMLINK) throw new PackageRefused(`${name} is a symbolic link: a package holds files and folders only`);
      if (isFolder) continue;
      if (!entry.canDecodeFileData()) {
        throw new PackageRefused(`${name} is packed with method ${entry.compressionMethod}: a package's files are stored or deflated, as zip tools do`);
      }
      files.push(name);
      if (files.length > limits.files) throw new PackageRefused(`The package has more than ${bytes(limits.files)} files`);
      declared += entry.uncompressedSize;
      if (declared > limits.unpackedBytes) {
        throw new PackageRefused(`The package is over ${bytes(limits.unpackedBytes)} bytes unpacked, as AWS Lambda allows (250 MB)`);
      }
      if (entry.uncompressedSize > limits.ratioFloor && entry.uncompressedSize > entry.compressedSize * limits.ratio) {
        throw new PackageRefused(`${name} is packed more than ${bytes(limits.ratio)} times over, as zip bombs are`);
      }
      unpackedSize += await check(zip, entry, name);
    }
    if (files.length === 0) throw new PackageRefused("The package has no file: zip the function's folder, its handler's file at the root");
    // A file can't also be a folder, which a container image's layer would have to make it.
    const isFile = new Set(files);
    for (const name of names) {
      for (let folder = path.dirname(name); folder !== '.'; folder = path.dirname(folder)) {
        if (isFile.has(folder)) throw new PackageRefused(`${folder} is a file and a folder of the package`);
      }
    }
    return { files: files.sort(), unpackedSize };
  } catch (error) {
    if (error instanceof PackageRefused) throw error;
    throw new PackageRefused(`The package can't be read: ${describeZipError(error)}`);
  } finally {
    zip.close();
  }
}

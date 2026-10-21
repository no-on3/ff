// Shared by the packages' tests (not part of the build: tsconfig.build.json
// excludes test-fixtures.ts): a zip archive written byte by byte, which can be
// what no zip tool makes, a name with .., a link, a size or a checksum that lies.
import { createHash, randomUUID } from 'node:crypto';
import { Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
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

const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * A registry in the test's process, enough of the OCI distribution API for the
 * client: blobs uploaded in one request after a POST, manifests by tag and by
 * digest. It can fail the next uploads with 500, or drop their connection.
 */
export class FakeRegistry {
  readonly blobs = new Map<string, Buffer>();
  readonly manifests = new Map<string, Buffer>();
  readonly requests: Array<{ method: string; path: string; authorization?: string; contentType?: string }> = [];
  /** What the next PUTs of uploads do instead of storing: answer 500, or close the connection. */
  failUploads: Array<'500' | 'drop'> = [];
  private readonly uploads = new Set<string>();
  private server!: Server;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const url = new URL(request.url ?? '/', 'http://registry');
        this.requests.push({ method: request.method ?? '', path: url.pathname, authorization: request.headers.authorization, contentType: request.headers['content-type'] });
        const body = Buffer.concat(chunks);
        const blob = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
        const upload = /^\/v2\/(.+)\/blobs\/uploads\/([0-9a-f-]*)$/.exec(url.pathname);
        const manifest = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
        if (blob && request.method === 'HEAD') return response.writeHead(this.blobs.has(blob[2]) ? 200 : 404).end();
        if (upload && request.method === 'POST') {
          const id = randomUUID();
          this.uploads.add(id);
          return response.writeHead(202, { location: `/v2/${upload[1]}/blobs/uploads/${id}?_state=opaque` }).end();
        }
        if (upload && request.method === 'PUT') {
          const failure = this.failUploads.shift();
          // A failed upload is forgotten, as registries may do: the next try must start another.
          this.uploads.delete(upload[2]);
          if (failure === 'drop') return request.socket.destroy();
          if (failure === '500') return response.writeHead(500).end('storage unavailable');
          const digest = url.searchParams.get('digest') ?? '';
          if (url.searchParams.get('_state') !== 'opaque') return response.writeHead(400).end('lost the upload state');
          if (sha256(body) !== digest) return response.writeHead(400).end('DIGEST_INVALID');
          this.blobs.set(digest, body);
          return response.writeHead(201).end();
        }
        if (upload && request.method === 'GET') return response.writeHead(this.uploads.has(upload[2]) ? 204 : 404).end();
        if (manifest && request.method === 'PUT') {
          const digest = sha256(body);
          this.manifests.set(`${manifest[1]}:${manifest[2]}`, body);
          this.manifests.set(`${manifest[1]}@${digest}`, body);
          return response.writeHead(201, { 'docker-content-digest': digest }).end();
        }
        if (manifest && request.method === 'HEAD') return response.writeHead(this.manifests.has(`${manifest[1]}@${manifest[2]}`) ? 200 : 404).end();
        if (manifest && request.method === 'DELETE') {
          const key = `${manifest[1]}@${manifest[2]}`;
          if (!this.manifests.delete(key)) return response.writeHead(404).end();
          return response.writeHead(202).end();
        }
        response.writeHead(400).end('unexpected');
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

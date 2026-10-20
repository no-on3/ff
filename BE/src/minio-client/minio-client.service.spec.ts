/**
 * L1: what the object-storage client sends, checked on a local fake S3
 * server (client-readiness plan, P-09). hack/e2e.sh checks the same calls
 * against SeaweedFS.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { MinioClientService } from './minio-client.service';

interface Captured {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local stand-in for an S3 server: records requests, answers with the handler's reply. */
async function fakeS3(reply: (req: Captured) => { status: number; body?: string } = () => ({ status: 200 })) {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = {
        method: req.method ?? '',
        path: new URL(req.url ?? '/', 'http://s3').pathname,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      captured.push(request);
      const { status, body } = reply(request);
      res.writeHead(status, { 'content-type': 'application/xml' });
      res.end(body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    captured,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const s3Error = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;

describe('MinioClientService (L1, P-09)', () => {
  const opened: Array<{ close: () => unknown }> = [];

  function storage(port: number) {
    const values: Record<string, unknown> = {
      // A host name, as in production: with an IP address the SDK puts the bucket in the path anyway.
      'minio.endPoint': 'localhost',
      'minio.port': port,
      'minio.useSSL': false,
      'minio.accessKey': 'ffdevaccesskey',
      'minio.secretKey': 'ffdevsecretkey-local-only',
      'minio.bucketName': 'functions',
    };
    const service = new MinioClientService({ get: (key: string) => values[key] } as unknown as ConfigService);
    opened.push({ close: () => service.onModuleDestroy() });
    return service;
  }

  async function server(reply?: Parameters<typeof fakeS3>[0]) {
    const s3 = await fakeS3(reply);
    opened.push(s3);
    return s3;
  }

  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
    jest.restoreAllMocks();
  });

  it('creates the bucket at startup when it is missing', async () => {
    const s3 = await server((req) => (req.method === 'HEAD' ? { status: 404 } : { status: 200 }));

    await storage(s3.port).onModuleInit();

    expect(s3.captured.map((r) => `${r.method} ${r.path}`)).toEqual(['HEAD /functions/', 'PUT /functions/']);
  });

  it('keeps a bucket that exists', async () => {
    const s3 = await server();

    await storage(s3.port).onModuleInit();

    expect(s3.captured.map((r) => `${r.method} ${r.path}`)).toEqual(['HEAD /functions/']);
  });

  it('starts anyway when the storage is unreachable', async () => {
    const s3 = await server();
    const { port } = s3;
    await s3.close(); // nothing listens there any more
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(storage(port).onModuleInit()).resolves.toBeUndefined();

    // Not the reason: under Jest, the SDK wraps Node's connection errors, which come from another realm.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('Cannot check or create bucket "functions": '));
  });

  it('says why the bucket check failed, with the HTTP status, e.g. for a wrong key', async () => {
    const s3 = await server(() => ({ status: 403 })); // an answer to HEAD has no body
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await storage(s3.port).onModuleInit();

    expect(logged).toHaveBeenCalledWith('Cannot check or create bucket "functions": UnknownError (HTTP 403)');
    expect(s3.captured.map((r) => r.method)).toEqual(['HEAD']); // no attempt to create it
  });

  it('uploads the code into the bucket, signed with the key, without the checksums S3-compatible stores may refuse', async () => {
    const s3 = await server();
    const code = 'export const handler = async () => "héllo";';

    await storage(s3.port).uploadCode('3f9c2a1e/code.ts', code);

    const [put] = s3.captured;
    expect(put).toMatchObject({ method: 'PUT', path: '/functions/3f9c2a1e/code.ts', body: code });
    expect(put.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ffdevaccesskey\/\d{8}\/us-east-1\/s3\/aws4_request,/);
    expect(Object.keys(put.headers).filter((name) => name.startsWith('x-amz-checksum') || name === 'x-amz-sdk-checksum-algorithm')).toEqual([]);
    expect(put.headers['content-encoding']).toBeUndefined(); // not aws-chunked
  });

  it('deletes the code', async () => {
    const s3 = await server((req) => ({ status: req.method === 'DELETE' ? 204 : 200 }));

    await storage(s3.port).deleteCode('3f9c2a1e/code.ts');

    expect(s3.captured.map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /functions/3f9c2a1e/code.ts']);
  });

  it('fails an upload that the store refuses, so that the caller knows', async () => {
    const s3 = await server(() => ({ status: 403, body: s3Error('AccessDenied') }));

    await expect(storage(s3.port).uploadCode('3f9c2a1e/code.ts', 'code')).rejects.toMatchObject({ name: 'AccessDenied' });
  });
});

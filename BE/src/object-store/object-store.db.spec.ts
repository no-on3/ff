/**
 * L2: FF's own object store, a real one: what the backend keeps there read back as it was kept, whole with its type
 * and streamed to a file, as a function's export and its code image read a package; and an object the store hasn't
 * said missing, as a package lost with the store is, which the restore of code images tells from a store that fails.
 * In a bucket of the run's own, which the backend makes as it starts, deleted afterwards.
 *   docker compose up -d --wait s3 && npm run test:db
 */
import 'dotenv/config';
import { DeleteBucketCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageKey } from '../packages/package.entity';
import { zipOf } from '../packages/test-fixtures';
import { ObjectStoreService, StoredObjectMissingError } from './object-store.service';
import { testObjectStore, testStoreClient } from './test-fixtures';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ACCOUNT = '720000000001';

run("FF's own object store, a real one (L2)", () => {
  const bucketName = `ff-l2-objects-${randomBytes(4).toString('hex')}`;
  const store = new ObjectStoreService(new ConfigService({ objectStore: { ...testObjectStore(), bucketName } }));
  const client = testStoreClient();
  const kept: string[] = [];
  let dir: string;

  beforeAll(async () => {
    await store.onModuleInit();
    dir = mkdtempSync(join(tmpdir(), 'ff-object-store-'));
  });

  afterAll(async () => {
    for (const key of kept) await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key })).catch(() => undefined);
    await client.send(new DeleteBucketCommand({ Bucket: bucketName })).catch(() => undefined);
    client.destroy();
    store.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a package of a few megabytes back as it was kept, whole with its type and streamed to a file, byte for byte', async () => {
    const zip = zipOf([
      { name: 'index.js', data: "exports.handler = async () => require('./big').length;\n" },
      { name: 'big.js', data: `module.exports = '${randomBytes(3 * 1024 * 1024).toString('base64')}';\n`, method: 0 },
    ]);
    const key = packageKey(ACCOUNT, randomBytes(32).toString('base64'));
    kept.push(key);
    await store.putDocument(key, zip, 'application/zip');
    const file = join(dir, 'package.zip');

    const document = await store.getDocument(key);
    await store.getFile(key, file);

    expect([document.contentType, document.body.equals(zip), readFileSync(file).equals(zip)]).toEqual(['application/zip', true, true]);
  });

  it("says an object it hasn't missing, either way, naming it", async () => {
    const key = packageKey(ACCOUNT, randomBytes(32).toString('base64'));

    for (const read of [() => store.getDocument(key), () => store.getFile(key, join(dir, 'lost.zip'))]) {
      const error = await read().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(StoredObjectMissingError);
      expect(error).toHaveProperty('message', `Object storage has no ${key}`);
    }
  });
});

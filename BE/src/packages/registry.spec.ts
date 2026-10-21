import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDIA_TYPES, Registry, RegistryError, bytesBlob, fileBlob } from './registry';
import { FakeRegistry } from './test-fixtures';

const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('Registry: the OCI distribution API, as code images need it', () => {
  const fake = new FakeRegistry();
  let dir: string;
  const REPO = 'ff-code/123456789012';

  beforeAll(async () => {
    await fake.start();
    dir = mkdtempSync(join(tmpdir(), 'ff-registry-test-'));
  });
  afterAll(async () => {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    fake.requests.length = 0;
    fake.failUploads = [];
  });

  const registry = (credentials?: { username: string; password: string }) => new Registry(fake.url, credentials, 1);
  const calls = () => fake.requests.map((request) => `${request.method} ${request.path.replace(/\/uploads\/[0-9a-f-]{36}$/, '/uploads/<upload>')}`);

  it('pushes a blob in one request after its upload starts, and nothing when the registry has it', async () => {
    const blob = bytesBlob(randomBytes(4096));

    await registry().pushBlob(REPO, blob);
    await registry().pushBlob(REPO, blob);

    expect(calls()).toEqual([
      `HEAD /v2/${REPO}/blobs/${blob.digest}`,
      `POST /v2/${REPO}/blobs/uploads/`,
      `PUT /v2/${REPO}/blobs/uploads/<upload>`,
      `HEAD /v2/${REPO}/blobs/${blob.digest}`,
    ]);
    expect(fake.blobs.get(blob.digest)?.length).toBe(4096);
  });

  it('streams a blob from its file', async () => {
    const bytes = randomBytes(300_000);
    const file = join(dir, 'layer.tar.gz');
    writeFileSync(file, bytes);

    await registry().pushBlob(REPO, fileBlob(file, sha256(bytes), bytes.length));

    expect(fake.blobs.get(sha256(bytes))?.equals(bytes)).toBe(true);
  });

  it('starts an upload again when one fails, or gets no answer, and gives up after three tries, saying why', async () => {
    const blob = bytesBlob(randomBytes(64));
    fake.failUploads = ['500', 'drop'];

    await registry().pushBlob(REPO, blob);

    expect(calls().filter((call) => call.startsWith('POST'))).toHaveLength(3);
    expect(fake.blobs.has(blob.digest)).toBe(true);

    const another = bytesBlob(randomBytes(64));
    fake.failUploads = ['500', '500', '500'];
    await expect(registry().pushBlob(REPO, another)).rejects.toThrow(RegistryError);
    expect(fake.blobs.has(another.digest)).toBe(false);
  });

  it('takes a refusal as final: no second try', async () => {
    const lying = { ...bytesBlob(randomBytes(64)), digest: `sha256:${'0'.repeat(64)}` };

    await expect(registry().pushBlob(REPO, lying)).rejects.toThrow(`The registry refused blob ${lying.digest}: 400 DIGEST_INVALID`);
    expect(calls().filter((call) => call.startsWith('PUT'))).toHaveLength(1);
  });

  it('pushes a manifest under its tag, answers its digest, finds it by that digest, and deletes it once', async () => {
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA_TYPES.manifest }));

    const digest = await registry().pushManifest(REPO, 'abc', manifest);

    expect(digest).toBe(sha256(manifest));
    expect(fake.requests.at(-1)?.contentType).toBe(MEDIA_TYPES.manifest);
    expect(await registry().hasManifest(REPO, digest)).toBe(true);
    await registry().deleteManifest(REPO, digest);
    expect(await registry().hasManifest(REPO, digest)).toBe(false);
    // Already gone: nothing to do.
    await expect(registry().deleteManifest(REPO, digest)).resolves.toBeUndefined();
  });

  it('sends its login, when it has one, with every request', async () => {
    await registry({ username: 'ff-backend', password: 'pa55' }).hasBlob(REPO, `sha256:${'1'.repeat(64)}`);
    await registry().hasBlob(REPO, `sha256:${'1'.repeat(64)}`);

    expect(fake.requests.map((request) => request.authorization)).toEqual([`Basic ${Buffer.from('ff-backend:pa55').toString('base64')}`, undefined]);
  });

  it('says so when the registry is unreachable', async () => {
    await expect(new Registry('http://127.0.0.1:9', undefined, 1).hasBlob(REPO, `sha256:${'1'.repeat(64)}`)).rejects.toThrow(/got no answer/);
  });
});

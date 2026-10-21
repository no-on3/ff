import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CodeImagesService, CodeImagesSettings, codeRepository } from './code-images.service';
import { packageKey } from './package.entity';
import { MEDIA_TYPES } from './registry';
import { FakeRegistry, zipOf } from './test-fixtures';

const ACCOUNT = '123456789012';
const ZIP = zipOf([
  { name: 'src/orders.js', data: 'exports.create = async (event) => ({ created: event.id });\n' },
  { name: 'node_modules/left-pad/index.js', data: 'module.exports = (s) => s;\n' },
]);
const SHA = createHash('sha256').update(ZIP).digest('base64');

describe('CodeImagesService: a package as the image its pods mount', () => {
  const fake = new FakeRegistry();
  /** The package's row: its image's digest, as the service keeps it. */
  let row: { id: string; imageDigest: string | null };
  const packages = {
    findOne: jest.fn(async () => row),
    update: jest.fn(async (_where: unknown, changes: { imageDigest: string }) => void (row.imageDigest = changes.imageDigest)),
  };
  /** Object storage, which holds the package's zip. */
  const storage = { getFile: jest.fn(async (_key: string, file: string) => writeFileSync(file, ZIP)) };
  const service = (settings: Partial<CodeImagesSettings> = {}) =>
    new CodeImagesService(packages as never, storage as never, {
      getOrThrow: () => ({ registry: fake.url, pullHost: 'ff-dev-registry:5000', username: '', password: '', ...settings }),
    } as unknown as ConfigService);

  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  beforeEach(() => {
    jest.clearAllMocks();
    row = { id: 'p-1', imageDigest: null };
    fake.requests.length = 0;
  });

  it('makes the image the first time: its layer, its configuration and its manifest, pushed; its digest kept; its reference as the nodes pull it', async () => {
    const image = await service().imageFor(ACCOUNT, SHA);

    const repository = codeRepository(ACCOUNT);
    const tag = Buffer.from(SHA, 'base64').toString('hex');
    const manifest = JSON.parse(fake.manifests.get(`${repository}:${tag}`)!.toString());
    expect(storage.getFile).toHaveBeenCalledWith(packageKey(ACCOUNT, SHA), expect.any(String));
    expect(manifest).toEqual({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.manifest,
      config: { mediaType: MEDIA_TYPES.config, digest: expect.stringMatching(/^sha256:/), size: expect.any(Number) },
      layers: [{ mediaType: MEDIA_TYPES.layer, digest: expect.stringMatching(/^sha256:/), size: expect.any(Number) }],
    });
    const config = JSON.parse(fake.blobs.get(manifest.config.digest)!.toString());
    expect(config).toEqual({
      architecture: 'amd64',
      os: 'linux',
      config: { Labels: { 'ff.dev/account': ACCOUNT, 'ff.dev/code-sha256': SHA } },
      rootfs: { type: 'layers', diff_ids: [expect.stringMatching(/^sha256:[0-9a-f]{64}$/)] },
    });
    expect(fake.blobs.has(manifest.layers[0].digest)).toBe(true);
    expect(image).toBe(`ff-dev-registry:5000/${repository}@${row.imageDigest}`);
    expect(row.imageDigest).toBe(`sha256:${createHash('sha256').update(fake.manifests.get(`${repository}:${tag}`)!).digest('hex')}`);
  });

  it('asks the registry for it after, and makes nothing again while the registry has it', async () => {
    const first = await service().imageFor(ACCOUNT, SHA);
    fake.requests.length = 0;

    expect(await service().imageFor(ACCOUNT, SHA)).toBe(first);
    expect(fake.requests.map((request) => request.method)).toEqual(['HEAD']);
    expect(storage.getFile).toHaveBeenCalledTimes(1);
  });

  it('makes it again, the same, when the registry lost it', async () => {
    const first = await service().imageFor(ACCOUNT, SHA);
    for (const key of [...fake.manifests.keys()]) fake.manifests.delete(key);

    expect(await service().imageFor(ACCOUNT, SHA)).toBe(first);
    expect(storage.getFile).toHaveBeenCalledTimes(2);
  });

  it('deletes an image by its digest, which the registry collects after', async () => {
    await service().imageFor(ACCOUNT, SHA);

    await service().deleteImage(ACCOUNT, row.imageDigest!);

    expect(fake.manifests.has(`${codeRepository(ACCOUNT)}@${row.imageDigest}`)).toBe(false);
  });

  it("says, with 503, that a package can't run where FF has no registry; and deletes nothing there", async () => {
    const without = service({ registry: '', pullHost: '' });

    expect(() => without.assertAvailable()).toThrow(ServiceUnavailableException);
    await expect(without.imageFor(ACCOUNT, SHA)).rejects.toThrow("This FF has no code registry, so it can't run a package: its operator sets FF_CODE_REGISTRY (ADR 0003)");
    await expect(without.deleteImage(ACCOUNT, `sha256:${'0'.repeat(64)}`)).resolves.toBeUndefined();
  });

  it('leaves no working file behind, made or failed', async () => {
    const working = () => readdirSync(tmpdir()).filter((name) => name.startsWith('ff-image-'));
    const before = working();
    storage.getFile.mockImplementationOnce(async (_key: string, file: string) => copyFileSync('/nonexistent', file));

    await expect(service().imageFor(ACCOUNT, SHA)).rejects.toThrow();
    await service().imageFor(ACCOUNT, SHA);

    expect(working().filter((name) => !before.includes(name))).toEqual([]);
  });
});

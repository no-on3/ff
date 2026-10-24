import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { ObjectStoreService } from '../object-store/object-store.service';
import { buildLayer } from './code-layer';
import { Package, packageKey } from './package.entity';
import { MEDIA_TYPES, Registry, bytesBlob, fileBlob } from './registry';

/** Where code images go, as the configuration gives it (FF_CODE_REGISTRY…): none without a registry. */
export interface CodeImagesSettings {
  /** The registry's URL, which the backend pushes to; empty: no function can be deployed. */
  registry: string;
  /** The registry's host, as the cluster's nodes pull from it. */
  pullHost: string;
  username: string;
  password: string;
}

/** An account's code images: one repository each, a tag per package, its SHA-256 in hex. */
export const codeRepository = (accountId: string): string => `ff-code/${accountId}`;
const tagOf = (codeSha256: string): string => Buffer.from(codeSha256, 'base64').toString('hex');

/**
 * Makes a package's image from its zip, `zip` a file of `work`, and pushes it:
 * the layer, its configuration, then the manifest. Answers its digest. No time
 * and no history in it: the same package makes the same image.
 */
export async function pushCodeImage(registry: Registry, accountId: string, codeSha256: string, zip: string, work: string): Promise<{ digest: string; layerSize: number }> {
  const layerFile = join(work, 'layer.tar.gz');
  const layer = await buildLayer(zip, layerFile);
  const repository = codeRepository(accountId);
  await registry.pushBlob(repository, fileBlob(layerFile, layer.digest, layer.size));
  const config = bytesBlob(
    Buffer.from(
      JSON.stringify({
        architecture: 'amd64',
        os: 'linux',
        config: { Labels: { 'ff.dev/account': accountId, 'ff.dev/code-sha256': codeSha256 } },
        rootfs: { type: 'layers', diff_ids: [layer.diffId] },
      }),
    ),
  );
  await registry.pushBlob(repository, config);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.manifest,
      config: { mediaType: MEDIA_TYPES.config, digest: config.digest, size: config.size },
      layers: [{ mediaType: MEDIA_TYPES.layer, digest: layer.digest, size: layer.size }],
    }),
  );
  return { digest: await registry.pushManifest(repository, tagOf(codeSha256), manifest), layerSize: layer.size };
}

/**
 * Functions' code images (ADR 0003): a package's files as an image of one
 * layer, which the function's pods mount at /var/task on their runtime's image.
 * Made the first time a function names the package, from its zip in object
 * storage, pushed to the registry, and its digest kept with the package; made
 * again when the registry has lost it, or part of it: at a deploy, and by the
 * hourly restore of lost images (FunctionsService.restoreCodeImages). The same
 * backend makes the same image of a package.
 */
@Injectable()
export class CodeImagesService {
  private readonly logger = new Logger(CodeImagesService.name);
  private readonly settings: CodeImagesSettings;
  private readonly registry?: Registry;

  constructor(
    @InjectRepository(Package) private readonly packages: Repository<Package>,
    private readonly storage: ObjectStoreService,
    config: ConfigService,
  ) {
    this.settings = config.getOrThrow<CodeImagesSettings>('codeImages');
    if (this.settings.registry) {
      this.registry = new Registry(this.settings.registry, this.settings.username ? { username: this.settings.username, password: this.settings.password } : undefined);
    }
  }

  /** Whether this FF has a registry, which every function's code reaches its pods through. */
  get available(): boolean {
    return this.registry !== undefined;
  }

  /** 503 when this FF has no registry: no function's code can reach its pods, and its operator says where images go. */
  assertAvailable(): void {
    if (!this.registry) {
      throw new ServiceUnavailableException(
        "This FF has no code registry, so it can't deploy a function: its operator sets FF_CODE_REGISTRY (ADR 0003); in development, BE/.env.example names the one hack/k8s/registry-up.sh runs",
      );
    }
  }

  /**
   * The image that runs the account's package, by digest, as the cluster's
   * nodes pull it: made and pushed the first time, and again when the registry
   * doesn't have it whole.
   */
  async imageFor(accountId: string, codeSha256: string): Promise<string> {
    return (await this.ensureImage(accountId, codeSha256)).reference;
  }

  /** The package's image, as imageFor gives it, and whether it was made now: the first time, or because the registry had lost it. */
  async ensureImage(accountId: string, codeSha256: string): Promise<{ reference: string; made: boolean }> {
    this.assertAvailable();
    const registry = this.registry as Registry;
    const repository = codeRepository(accountId);
    const record = await this.packages.findOne({ where: { accountId, codeSha256 }, select: { id: true, imageDigest: true } });
    if (!record) throw new Error(`Account ${accountId} has no package ${codeSha256}`);
    if (record.imageDigest && (await registry.hasImage(repository, record.imageDigest))) {
      return { reference: `${this.settings.pullHost}/${repository}@${record.imageDigest}`, made: false };
    }
    const digest = await this.make(registry, accountId, codeSha256);
    await this.packages.update({ id: record.id }, { imageDigest: digest });
    return { reference: `${this.settings.pullHost}/${repository}@${digest}`, made: true };
  }

  /**
   * Whether the registry has, whole, the image a function's pods mount, by the
   * reference its nodes pull it with. No for one it lost, and for one it can't
   * have: another registry's, or not a code image at all.
   */
  async hasMounted(reference: string): Promise<boolean> {
    this.assertAvailable();
    const prefix = `${this.settings.pullHost}/`;
    if (!reference.startsWith(prefix)) return false;
    const [repository, digest] = reference.slice(prefix.length).split('@');
    if (!repository.startsWith('ff-code/') || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) return false;
    return (this.registry as Registry).hasImage(repository, digest);
  }

  /** Makes the package's image from its zip in object storage, and pushes it (pushCodeImage). Answers its digest. */
  private async make(registry: Registry, accountId: string, codeSha256: string): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), 'ff-image-'));
    try {
      const zip = join(work, 'package.zip');
      await this.storage.getFile(packageKey(accountId, codeSha256), zip);
      const { digest, layerSize } = await pushCodeImage(registry, accountId, codeSha256, zip, work);
      this.logger.log(`Pushed the code image of package ${codeSha256} of account ${accountId}: ${codeRepository(accountId)}@${digest}, its layer ${layerSize} bytes`);
      return digest;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Deletes a package's image, its manifest, which the registry's garbage collection follows. Nothing without a registry. */
  async deleteImage(accountId: string, imageDigest: string): Promise<void> {
    await this.registry?.deleteManifest(codeRepository(accountId), imageDigest);
  }
}

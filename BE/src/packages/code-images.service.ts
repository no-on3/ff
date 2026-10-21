import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { MinioClientService } from '../minio-client/minio-client.service';
import { buildLayer } from './code-layer';
import { Package, packageKey } from './package.entity';
import { MEDIA_TYPES, Registry, bytesBlob, fileBlob } from './registry';

/** Where code images go, as the configuration gives it (FF_CODE_REGISTRY…): none without a registry. */
export interface CodeImagesSettings {
  /** The registry's URL, which the backend pushes to; empty: packages can't run. */
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
 * Functions' code images (ADR 0003): a package's files as an image of one
 * layer, which the function's pods mount at /var/task on their runtime's image.
 * Made the first time a function names the package, from its zip in object
 * storage, pushed to the registry, and its digest kept with the package; made
 * again when the registry has lost it. The same package makes the same image.
 */
@Injectable()
export class CodeImagesService {
  private readonly logger = new Logger(CodeImagesService.name);
  private readonly settings: CodeImagesSettings;
  private readonly registry?: Registry;

  constructor(
    @InjectRepository(Package) private readonly packages: Repository<Package>,
    private readonly storage: MinioClientService,
    config: ConfigService,
  ) {
    this.settings = config.getOrThrow<CodeImagesSettings>('codeImages');
    if (this.settings.registry) {
      this.registry = new Registry(this.settings.registry, this.settings.username ? { username: this.settings.username, password: this.settings.password } : undefined);
    }
  }

  /** 503 when this FF has no registry: a package can't run here, and its operator says where images go. */
  assertAvailable(): void {
    if (!this.registry) {
      throw new ServiceUnavailableException("This FF has no code registry, so it can't run a package: its operator sets FF_CODE_REGISTRY (ADR 0003)");
    }
  }

  /**
   * The image that runs the account's package, by digest, as the cluster's
   * nodes pull it: made and pushed the first time, and again when the registry
   * doesn't have it.
   */
  async imageFor(accountId: string, codeSha256: string): Promise<string> {
    this.assertAvailable();
    const registry = this.registry as Registry;
    const repository = codeRepository(accountId);
    const record = await this.packages.findOne({ where: { accountId, codeSha256 }, select: { id: true, imageDigest: true } });
    if (!record) throw new Error(`Account ${accountId} has no package ${codeSha256}`);
    let digest = record.imageDigest;
    if (!digest || !(await registry.hasManifest(repository, digest))) {
      digest = await this.make(registry, accountId, codeSha256);
      await this.packages.update({ id: record.id }, { imageDigest: digest });
    }
    return `${this.settings.pullHost}/${repository}@${digest}`;
  }

  /** Makes the package's image from its zip, and pushes it: the layer, its configuration, then the manifest. Answers its digest. */
  private async make(registry: Registry, accountId: string, codeSha256: string): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), 'ff-image-'));
    try {
      const zip = join(work, 'package.zip');
      const layerFile = join(work, 'layer.tar.gz');
      await this.storage.getFile(packageKey(accountId, codeSha256), zip);
      const layer = await buildLayer(zip, layerFile);
      const repository = codeRepository(accountId);
      await registry.pushBlob(repository, fileBlob(layerFile, layer.digest, layer.size));
      // No time and no history: the same package makes the same configuration, and the same digest.
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
      const digest = await registry.pushManifest(repository, tagOf(codeSha256), manifest);
      this.logger.log(`Pushed the code image of package ${codeSha256} of account ${accountId}: ${repository}@${digest}, its layer ${layer.size} bytes`);
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

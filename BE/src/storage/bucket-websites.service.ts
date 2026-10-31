import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ChangedBy } from './bucket-notifications.service';
import { Bucket, BucketStatus } from './bucket.entity';
import { WebsiteView } from './dto/website.dto';
import { S3Error } from './s3-error';
import { WebsiteConfiguration, WebsiteConfigurationJson, siteUrl, websiteFromJson, websiteJson } from './website';

/**
 * Buckets' website configurations, as S3's: set whole, or removed, through the
 * S3 front door or FF's API. With one, the bucket's files are a site, public to
 * read at its address, `<bucket>.<the sites' host>`; its S3 API stays signed.
 * Each change in the audit log.
 */
@Injectable()
export class BucketWebsitesService {
  private readonly sites: URL;

  constructor(
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.sites = new URL(config.getOrThrow<string>('website.base'));
  }

  /** GET /buckets/:name/website: the configuration and the site's address; 404 for a bucket that is no site. */
  async get(accountId: string, name: string): Promise<WebsiteView> {
    const bucket = await this.bucketOf(accountId, name);
    if (!bucket.website) throw new NotFoundException(`The bucket "${name}" is no site: it has no website configuration`);
    return this.view(bucket.name, bucket.website);
  }

  /** PUT /buckets/:name/website: as S3's PutBucketWebsite, the configuration replaced whole; S3's refusals as 400. */
  async put(accountId: string, name: string, json: WebsiteConfigurationJson): Promise<WebsiteView> {
    const bucket = await this.bucketOf(accountId, name);
    let website: WebsiteConfiguration;
    try {
      website = websiteFromJson(json);
    } catch (error) {
      if (error instanceof S3Error) throw new BadRequestException(`${error.code}: ${error.message}`);
      throw error;
    }
    await this.keep(bucket, website, {});
    return this.view(bucket.name, website);
  }

  /** DELETE /buckets/:name/website: as S3's DeleteBucketWebsite, the site gone, its files kept; nothing to remove is no error. */
  async remove(accountId: string, name: string): Promise<void> {
    const bucket = await this.bucketOf(accountId, name);
    if (bucket.website) await this.keep(bucket, null, {});
  }

  /** Keeps a bucket's configuration, or none, and logs the change, whichever way it came. */
  async keep(bucket: Bucket, website: WebsiteConfiguration | null, changedBy: ChangedBy): Promise<void> {
    await this.buckets.update({ id: bucket.id }, { website });
    await this.audit.record({
      accountId: bucket.accountId,
      action: 'bucket.website',
      resource: `bucket:${bucket.name}`,
      details: website ? { ...website } : { removed: true },
      ...(changedBy.actor ? { actor: changedBy.actor } : {}),
      ...(changedBy.ip ? { ip: changedBy.ip } : {}),
    });
  }

  private view(name: string, website: WebsiteConfiguration): WebsiteView {
    return { ...websiteJson(website), url: siteUrl(this.sites, name) };
  }

  private async bucketOf(accountId: string, name: string): Promise<Bucket> {
    const bucket = await this.buckets.findOneBy({ accountId, name, status: BucketStatus.ACTIVE });
    if (!bucket) throw new NotFoundException(`The account has no bucket named "${name}"`);
    return bucket;
  }
}

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { QueryDeepPartialEntity, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { FunctionUrl } from '../functions/entities/function-url.entity';
import { PlansService } from '../plans/plans.service';
import { Bucket, BucketStatus } from '../storage/bucket.entity';
import { siteUrl } from '../storage/website';
import { CustomDomain, DomainStatus } from './custom-domain.entity';
import { CustomDomainView, SiteDomainView } from './dto/custom-domain.dto';
import { DnsUnavailableError, DomainResolver, checkDomain, domainRecords } from './domain-check';
import { domainKey, domainProblem } from './domain-name';
import { FunctionUrlsService } from './function-urls.service';
import { functionDomain, urlHost } from './url-address';

/** The DNS questions the domains' checks ask: the backend's resolver, or a test's. */
export const DOMAIN_RESOLVER = Symbol('DOMAIN_RESOLVER');

/** PostgreSQL's unique_violation. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown) => error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION;

/** What a domain serves, and where its CNAME points: a function's URL, or a bucket's site. */
interface DomainTarget {
  /** The domains' rows it has: by its function, or by its bucket. */
  where: { functionId: string } | { bucketId: string };
  /** What the audit log names. */
  resource: string;
  /** The URL's host, or the site's, which a subdomain's CNAME names. */
  host: string;
  /** What a refusal names it: "… has no domain". */
  it: string;
}

/**
 * Customers' own domains for their functions' URLs and their buckets' sites:
 * added by an account to one of its URLs or sites, proved by DNS (a CNAME to
 * the URL's host or the site's, or a TXT record with the domain's token and
 * the edge's addresses), then served by the gateway, which hands a site's to
 * the website server, the edge getting their certificates on demand once the
 * backend says yes. Each change goes to the audit log; the account's plan
 * limits how many, of both together.
 */
@Injectable()
export class CustomDomainsService {
  constructor(
    @InjectRepository(CustomDomain) private readonly domains: Repository<CustomDomain>,
    private readonly urls: FunctionUrlsService,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(DOMAIN_RESOLVER) private readonly resolver: DomainResolver,
    @InjectRepository(Bucket) private readonly buckets: Repository<Bucket>,
  ) {}

  private get base(): string {
    return this.config.getOrThrow<string>('functionUrls.base');
  }

  private get edgeAddresses(): string[] {
    return this.config.getOrThrow<string[]>('functionUrls.edgeAddresses');
  }

  view(domain: CustomDomain, url: FunctionUrl): CustomDomainView {
    return {
      domain: domain.domain,
      functionId: domain.functionId as string,
      status: domain.status,
      records: domainRecords(domain.domain, urlHost(this.base, url.urlId), domain.token, this.edgeAddresses),
      checkedAt: domain.checkedAt,
      checkError: domain.checkError,
      verifiedAt: domain.verifiedAt,
      createdAt: domain.createdAt,
    };
  }

  async list(accountId: string, functionId: string): Promise<CustomDomainView[]> {
    const url = await this.urls.urlOf(accountId, functionId);
    return (await this.domainsOf(accountId, this.urlTarget(url))).map((domain) => this.view(domain, url));
  }

  /** Adds a domain to the function's URL, then checks its records at once: they may be there already. */
  async add(accountId: string, functionId: string, name: string): Promise<CustomDomainView> {
    const url = await this.urls.urlOf(accountId, functionId);
    return this.view(await this.addTo(accountId, this.urlTarget(url), name), url);
  }

  /** Checks the domain's records again, as its account asks once it has made them. */
  async verify(accountId: string, functionId: string, name: string): Promise<CustomDomainView> {
    const url = await this.urls.urlOf(accountId, functionId);
    const target = this.urlTarget(url);
    return this.view(await this.check(await this.domainOf(accountId, target, name), target), url);
  }

  async remove(accountId: string, functionId: string, name: string): Promise<void> {
    await this.removeFrom(accountId, this.urlTarget(await this.urls.urlOf(accountId, functionId)), name);
  }

  /** GET /buckets/:name/website/domains: the site's own domains, each with the records that prove it and where it stands. */
  async listForSite(accountId: string, bucketName: string): Promise<SiteDomainView[]> {
    const target = this.siteTarget(await this.bucketOf(accountId, bucketName));
    return (await this.domainsOf(accountId, target)).map((domain) => this.siteView(domain, bucketName, target));
  }

  /** Adds a domain to the bucket's site, then checks its records at once: a bucket that is a site, as a domain serves one. */
  async addToSite(accountId: string, bucketName: string, name: string): Promise<SiteDomainView> {
    const bucket = await this.bucketOf(accountId, bucketName);
    if (!bucket.website) throw new NotFoundException(`The bucket "${bucketName}" is no site: set its website configuration first`);
    const target = this.siteTarget(bucket);
    return this.siteView(await this.addTo(accountId, target, name), bucketName, target);
  }

  async verifyForSite(accountId: string, bucketName: string, name: string): Promise<SiteDomainView> {
    const target = this.siteTarget(await this.bucketOf(accountId, bucketName));
    return this.siteView(await this.check(await this.domainOf(accountId, target, name), target), bucketName, target);
  }

  async removeFromSite(accountId: string, bucketName: string, name: string): Promise<void> {
    await this.removeFrom(accountId, this.siteTarget(await this.bucketOf(accountId, bucketName)), name);
  }

  /** A function URL's domains, for the platform's support. */
  forFunction(functionId: string): Promise<CustomDomain[]> {
    return this.domains.find({ where: { functionId }, order: { createdAt: 'ASC' } });
  }

  /** The verified domain a request's host names, for the gateway, a site's with its bucket, a site or not; null for any other. */
  forHost(host: string): Promise<CustomDomain | null> {
    return this.domains.findOne({ where: { domain: domainKey(host), status: DomainStatus.VERIFIED }, relations: { bucket: true } });
  }

  private urlTarget(url: FunctionUrl): DomainTarget {
    return { where: { functionId: url.functionId }, resource: `function:${url.functionId}`, host: urlHost(this.base, url.urlId), it: "The function's URL" };
  }

  private siteTarget(bucket: Bucket): DomainTarget {
    const host = new URL(siteUrl(new URL(this.config.getOrThrow<string>('website.base')), bucket.name)).hostname;
    return { where: { bucketId: bucket.id }, resource: `bucket:${bucket.name}`, host, it: `The site ${bucket.name}` };
  }

  private siteView(domain: CustomDomain, bucket: string, target: DomainTarget): SiteDomainView {
    return {
      domain: domain.domain,
      bucket,
      status: domain.status,
      records: domainRecords(domain.domain, target.host, domain.token, this.edgeAddresses),
      checkedAt: domain.checkedAt,
      checkError: domain.checkError,
      verifiedAt: domain.verifiedAt,
      createdAt: domain.createdAt,
    };
  }

  /**
   * The account's bucket of that name. Its domains stay its own once it is no
   * longer a site, to read and remove: they count against the plan's limit,
   * and the gateway serves none of them until it is a site again.
   */
  private async bucketOf(accountId: string, name: string): Promise<Bucket> {
    const bucket = await this.buckets.findOneBy({ accountId, name, status: BucketStatus.ACTIVE });
    if (!bucket) throw new NotFoundException(`The account has no bucket named "${name}"`);
    return bucket;
  }

  private domainsOf(accountId: string, target: DomainTarget): Promise<CustomDomain[]> {
    return this.domains.find({ where: { accountId, ...target.where }, order: { createdAt: 'ASC' } });
  }

  /** A new domain for the target, within the plan's domains, both kinds together; its records checked at once. */
  private async addTo(accountId: string, target: DomainTarget, name: string): Promise<CustomDomain> {
    const domain = domainKey(name);
    const problem = domainProblem(domain, functionDomain(this.base), {
      allowPrivate: this.config.get<string>('nodeEnv') !== 'production',
      sitesDomain: new URL(this.config.getOrThrow<string>('website.base')).hostname,
    });
    if (problem) throw new BadRequestException(problem);
    const plan = await this.plans.forAccount(accountId);
    const count = await this.domains.countBy({ accountId });
    if (count >= plan.limits.customDomains) {
      throw new BadRequestException(`The ${plan.name} plan allows ${plan.limits.customDomains} custom domains, and the account has ${count}: remove one first`);
    }
    const row = this.domains.create({ domain, accountId, functionId: null, bucketId: null, ...target.where, token: randomBytes(16).toString('hex'), status: DomainStatus.PENDING });
    try {
      await this.domains.insert(row as QueryDeepPartialEntity<CustomDomain>);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`The account has ${domain} already: a domain serves one function's URL or one site`);
      throw error;
    }
    await this.audit.record({ accountId, action: 'custom_domain.add', resource: target.resource, details: { domain } });
    try {
      return await this.check(row, target);
    } catch (error) {
      // Proved by another account first: added all the same, pending, with why it can't be served.
      if (!(error instanceof ConflictException)) throw error;
      return row;
    }
  }

  private async removeFrom(accountId: string, target: DomainTarget, name: string): Promise<void> {
    const domain = await this.domainOf(accountId, target, name);
    await this.domains.delete({ id: domain.id });
    await this.audit.record({ accountId, action: 'custom_domain.remove', resource: target.resource, details: { domain: domain.domain } });
  }

  /**
   * Checks the records and saves what was found: proved, the domain is
   * verified; not, it is pending, with why, a verified one too, whose URL or
   * site then stops answering there. A DNS that doesn't answer changes nothing
   * but the reason. Another account's proof of the domain first is a conflict.
   */
  private async check(domain: CustomDomain, target: DomainTarget): Promise<CustomDomain> {
    domain.checkedAt = new Date();
    let outcome;
    try {
      outcome = await checkDomain(this.resolver, domain.domain, target.host, domain.token, this.edgeAddresses);
    } catch (error) {
      if (!(error instanceof DnsUnavailableError)) throw error;
      domain.checkError = error.message;
      return this.domains.save(domain);
    }
    const wasVerified = domain.status === DomainStatus.VERIFIED;
    if (!outcome.verified) {
      Object.assign(domain, { status: DomainStatus.PENDING, verifiedAt: null, checkError: outcome.problem });
      const saved = await this.domains.save(domain);
      if (wasVerified) await this.audit.record({ accountId: domain.accountId, action: 'custom_domain.unverify', resource: target.resource, details: { domain: domain.domain, problem: outcome.problem } });
      return saved;
    }
    Object.assign(domain, { status: DomainStatus.VERIFIED, verifiedAt: domain.verifiedAt ?? new Date(), checkError: null });
    try {
      const saved = await this.domains.save(domain);
      if (!wasVerified) await this.audit.record({ accountId: domain.accountId, action: 'custom_domain.verify', resource: target.resource, details: { domain: domain.domain, by: outcome.by } });
      return saved;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another account proved it first: its proof stands, and this one says why it can't.
      Object.assign(domain, { status: DomainStatus.PENDING, verifiedAt: null, checkError: `Another account serves ${domain.domain}: it proved the domain first` });
      await this.domains.save(domain);
      throw new ConflictException(domain.checkError);
    }
  }

  private async domainOf(accountId: string, target: DomainTarget, name: string): Promise<CustomDomain> {
    const domain = await this.domains.findOne({ where: { accountId, ...target.where, domain: domainKey(name) } });
    if (!domain) throw new NotFoundException(`${target.it} has no domain ${domainKey(name)}`);
    return domain;
  }
}

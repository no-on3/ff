import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { QueryDeepPartialEntity, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { FunctionUrl } from '../functions/entities/function-url.entity';
import { PlansService } from '../plans/plans.service';
import { CustomDomain, DomainStatus } from './custom-domain.entity';
import { CustomDomainView } from './dto/custom-domain.dto';
import { DnsUnavailableError, DomainResolver, checkDomain, domainRecords } from './domain-check';
import { domainKey, domainProblem } from './domain-name';
import { FunctionUrlsService } from './function-urls.service';
import { functionDomain, urlHost } from './url-address';

/** The DNS questions the domains' checks ask: the backend's resolver, or a test's. */
export const DOMAIN_RESOLVER = Symbol('DOMAIN_RESOLVER');

/** PostgreSQL's unique_violation. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown) => error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION;

/**
 * Customers' own domains for their functions' URLs: added by an account to one
 * of its URLs, proved by DNS (a CNAME to the URL's host, or a TXT record with
 * the domain's token and the edge's addresses), then served by the gateway,
 * the edge getting their certificates on demand once the backend says yes.
 * Each change goes to the audit log; the account's plan limits how many.
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
      functionId: domain.functionId,
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
    const domains = await this.domains.find({ where: { accountId, functionId }, order: { createdAt: 'ASC' } });
    return domains.map((domain) => this.view(domain, url));
  }

  /** Adds a domain to the function's URL, then checks its records at once: they may be there already. */
  async add(accountId: string, functionId: string, name: string): Promise<CustomDomainView> {
    const url = await this.urls.urlOf(accountId, functionId);
    const domain = domainKey(name);
    const problem = domainProblem(domain, functionDomain(this.base), { allowPrivate: this.config.get<string>('nodeEnv') !== 'production' });
    if (problem) throw new BadRequestException(problem);
    const plan = await this.plans.forAccount(accountId);
    const count = await this.domains.countBy({ accountId });
    if (count >= plan.limits.customDomains) {
      throw new BadRequestException(`The ${plan.name} plan allows ${plan.limits.customDomains} custom domains, and the account has ${count}: remove one first`);
    }
    const row = this.domains.create({ domain, accountId, functionId, token: randomBytes(16).toString('hex'), status: DomainStatus.PENDING });
    try {
      await this.domains.insert(row as QueryDeepPartialEntity<CustomDomain>);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`The account has ${domain} already: a domain serves one function`);
      throw error;
    }
    await this.audit.record({ accountId, action: 'custom_domain.add', resource: `function:${functionId}`, details: { domain } });
    let checked = row;
    try {
      checked = await this.check(row, url);
    } catch (error) {
      // Proved by another account first: added all the same, pending, with why it can't be served.
      if (!(error instanceof ConflictException)) throw error;
    }
    return this.view(checked, url);
  }

  /** Checks the domain's records again, as its account asks once it has made them. */
  async verify(accountId: string, functionId: string, name: string): Promise<CustomDomainView> {
    const url = await this.urls.urlOf(accountId, functionId);
    return this.view(await this.check(await this.domainOf(accountId, functionId, name), url), url);
  }

  async remove(accountId: string, functionId: string, name: string): Promise<void> {
    await this.urls.urlOf(accountId, functionId);
    const domain = await this.domainOf(accountId, functionId, name);
    await this.domains.delete({ id: domain.id });
    await this.audit.record({ accountId, action: 'custom_domain.remove', resource: `function:${functionId}`, details: { domain: domain.domain } });
  }

  /** A function URL's domains, for the platform's support. */
  forFunction(functionId: string): Promise<CustomDomain[]> {
    return this.domains.find({ where: { functionId }, order: { createdAt: 'ASC' } });
  }

  /** The verified domain a request's host names, for the gateway; null for any other. */
  forHost(host: string): Promise<CustomDomain | null> {
    return this.domains.findOne({ where: { domain: domainKey(host), status: DomainStatus.VERIFIED } });
  }

  /**
   * Checks the records and saves what was found: proved, the domain is
   * verified; not, it is pending, with why, a verified one too, whose URL then
   * stops answering there. A DNS that doesn't answer changes nothing but the
   * reason. Another account's proof of the domain first is a conflict.
   */
  private async check(domain: CustomDomain, url: FunctionUrl): Promise<CustomDomain> {
    domain.checkedAt = new Date();
    let outcome;
    try {
      outcome = await checkDomain(this.resolver, domain.domain, urlHost(this.base, url.urlId), domain.token, this.edgeAddresses);
    } catch (error) {
      if (!(error instanceof DnsUnavailableError)) throw error;
      domain.checkError = error.message;
      return this.domains.save(domain);
    }
    const wasVerified = domain.status === DomainStatus.VERIFIED;
    if (!outcome.verified) {
      Object.assign(domain, { status: DomainStatus.PENDING, verifiedAt: null, checkError: outcome.problem });
      const saved = await this.domains.save(domain);
      if (wasVerified) await this.audit.record({ accountId: domain.accountId, action: 'custom_domain.unverify', resource: `function:${domain.functionId}`, details: { domain: domain.domain, problem: outcome.problem } });
      return saved;
    }
    Object.assign(domain, { status: DomainStatus.VERIFIED, verifiedAt: domain.verifiedAt ?? new Date(), checkError: null });
    try {
      const saved = await this.domains.save(domain);
      if (!wasVerified) await this.audit.record({ accountId: domain.accountId, action: 'custom_domain.verify', resource: `function:${domain.functionId}`, details: { domain: domain.domain, by: outcome.by } });
      return saved;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Another account proved it first: its proof stands, and this one says why it can't.
      Object.assign(domain, { status: DomainStatus.PENDING, verifiedAt: null, checkError: `Another account serves ${domain.domain}: it proved the domain first` });
      await this.domains.save(domain);
      throw new ConflictException(domain.checkError);
    }
  }

  private async domainOf(accountId: string, functionId: string, name: string): Promise<CustomDomain> {
    const domain = await this.domains.findOne({ where: { accountId, functionId, domain: domainKey(name) } });
    if (!domain) throw new NotFoundException(`The function's URL has no domain ${domainKey(name)}`);
    return domain;
  }
}

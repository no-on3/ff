/**
 * L1: customers' own domains for their functions' URLs and their buckets'
 * sites, with a stand-in DNS: added, proved by a CNAME or a TXT record, served
 * once proved, not before; refused when they are no domain, over the plan's
 * limit, or the account's already; and the audit log's entries.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { FunctionUrl, UrlAuthType } from '../functions/entities/function-url.entity';
import { plan } from '../plans/test-fixtures';
import { Bucket, BucketStatus } from '../storage/bucket.entity';
import { CustomDomain, DomainStatus } from './custom-domain.entity';
import { CustomDomainsService } from './custom-domains.service';
import { DnsUnavailableError, DomainResolver } from './domain-check';

const ACCOUNT = '123456789012';
const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';
const URL_ID = '0123456789abcdefghijklmnopqrstuv';
const URL_HOST = `${URL_ID}.fn.example.tn`;
const SITE_HOST = 'docs.site.example.tn';

describe('CustomDomainsService (L1)', () => {
  let service: CustomDomainsService;
  let rows: CustomDomain[];
  /** The zone the stand-in DNS answers from; DnsUnavailableError when it is down. */
  let records: { cname: Record<string, string[]>; txt: Record<string, string[]>; addresses: Record<string, string[]> };
  let dnsDown: boolean;
  let limit: number;
  let buckets: Bucket[];
  const audit = { record: jest.fn() };
  const url = { functionId: FN, accountId: ACCOUNT, urlId: URL_ID, authType: UrlAuthType.NONE } as FunctionUrl;
  const urls = {
    urlOf: jest.fn(async (accountId: string, functionId: string) => {
      if (accountId !== ACCOUNT || functionId !== FN) throw new NotFoundException(`Function with ID ${functionId} not found`);
      return url;
    }),
  };
  const ask = (answers: Record<string, string[]>) => async (name: string) => {
    if (dnsDown) throw new DnsUnavailableError(name, 'ETIMEOUT');
    return answers[name] ?? [];
  };
  const resolver: DomainResolver = {
    cname: (name) => ask(records.cname)(name),
    txt: (name) => ask(records.txt)(name),
    addresses: (name) => ask(records.addresses)(name),
  };
  const unique = () => new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
  const repository = {
    create: (values: Partial<CustomDomain>) => ({ ...values, createdAt: new Date('2026-10-21T10:00:00Z'), checkedAt: null, checkError: null, verifiedAt: null }) as CustomDomain,
    countBy: jest.fn(async ({ accountId }: { accountId: string }) => rows.filter((row) => row.accountId === accountId).length),
    find: jest.fn(async ({ where }: { where: Partial<CustomDomain> }) => rows.filter((row) => Object.entries(where).every(([key, value]) => row[key as keyof CustomDomain] === value))),
    findOne: jest.fn(async ({ where, relations }: { where: Partial<CustomDomain>; relations?: { bucket?: boolean } }) => {
      const row = rows.find((r) => Object.entries(where).every(([key, value]) => r[key as keyof CustomDomain] === value));
      if (!row) return null;
      return relations?.bucket ? { ...row, bucket: buckets.find((bucket) => bucket.id === row.bucketId) } : { ...row };
    }),
    insert: jest.fn(async (row: CustomDomain) => {
      if (rows.some((r) => r.accountId === row.accountId && r.domain === row.domain)) throw unique();
      rows.push({ ...row, id: `d-${rows.length + 1}` });
      row.id = `d-${rows.length}`;
    }),
    save: jest.fn(async (row: CustomDomain) => {
      if (row.status === DomainStatus.VERIFIED && rows.some((r) => r.id !== row.id && r.domain === row.domain && r.status === DomainStatus.VERIFIED)) throw unique();
      rows = rows.map((r) => (r.id === row.id ? { ...row } : r));
      return row;
    }),
    delete: jest.fn(async ({ id }: { id: string }) => {
      rows = rows.filter((row) => row.id !== id);
    }),
  };
  const config = {
    getOrThrow: (key: string) => ({ 'functionUrls.base': 'https://fn.example.tn', 'functionUrls.edgeAddresses': ['203.0.113.10'], 'website.base': 'https://site.example.tn' })[key],
    get: (key: string) => (key === 'nodeEnv' ? 'production' : undefined),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    records = { cname: {}, txt: {}, addresses: {} };
    dnsDown = false;
    limit = 5;
    buckets = [
      { id: 'b-docs', accountId: ACCOUNT, name: 'docs', status: BucketStatus.ACTIVE, website: { indexDocument: 'index.html', errorDocument: null, singlePageApp: false } } as Bucket,
      { id: 'b-data', accountId: ACCOUNT, name: 'data', status: BucketStatus.ACTIVE, website: null } as Bucket,
    ];
    service = new CustomDomainsService(
      repository as never,
      urls as never,
      { forAccount: async () => plan({ customDomains: limit }) } as never,
      audit as never,
      config,
      resolver,
      { findOneBy: async (where: Partial<Bucket>) => buckets.find((bucket) => Object.entries(where).every(([key, value]) => bucket[key as keyof Bucket] === value)) ?? null } as never,
    );
  });

  it('adds a domain, pending, with the records that prove it, the two ways', async () => {
    const added = await service.add(ACCOUNT, FN, 'Shop.Example.TN.');

    expect(added).toMatchObject({ domain: 'shop.example.tn', functionId: FN, status: 'pending', verifiedAt: null });
    expect(added.records.cname).toEqual([{ type: 'CNAME', name: 'shop.example.tn', value: URL_HOST }]);
    expect(added.records.txt).toEqual([
      { type: 'TXT', name: '_ff-verify.shop.example.tn', value: expect.stringMatching(/^ff-verify=[0-9a-f]{32}$/) },
      { type: 'A', name: 'shop.example.tn', value: '203.0.113.10' },
    ]);
    expect(added.checkError).toBe(`Neither a CNAME from shop.example.tn to ${URL_HOST}, nor a TXT record at _ff-verify.shop.example.tn with "${added.records.txt[0].value}", was found`);
    expect(audit.record).toHaveBeenCalledWith({ accountId: ACCOUNT, action: 'custom_domain.add', resource: `function:${FN}`, details: { domain: 'shop.example.tn' } });
    expect(await service.forHost('shop.example.tn')).toBeNull(); // not served until proved
  });

  it('verifies a domain whose CNAME is there already, at once, and serves it', async () => {
    records.cname['shop.example.tn'] = [URL_HOST];

    const added = await service.add(ACCOUNT, FN, 'shop.example.tn');

    expect(added).toMatchObject({ status: 'verified', checkError: null, verifiedAt: expect.any(Date) });
    expect(await service.forHost('SHOP.example.tn')).toMatchObject({ functionId: FN, status: DomainStatus.VERIFIED });
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'custom_domain.verify', details: { domain: 'shop.example.tn', by: 'CNAME' } }));
  });

  it('verifies an apex once its TXT record and its address are there', async () => {
    const added = await service.add(ACCOUNT, FN, 'example.tn');
    records.txt['_ff-verify.example.tn'] = [added.records.txt[0].value];
    records.addresses['example.tn'] = ['203.0.113.10'];

    expect(await service.verify(ACCOUNT, FN, 'example.tn')).toMatchObject({ status: 'verified', checkError: null });
  });

  it("changes nothing but the reason when the DNS doesn't answer", async () => {
    records.cname['shop.example.tn'] = [URL_HOST];
    await service.add(ACCOUNT, FN, 'shop.example.tn');
    dnsDown = true;

    expect(await service.verify(ACCOUNT, FN, 'shop.example.tn')).toMatchObject({
      status: 'verified',
      checkError: "The DNS didn't answer for shop.example.tn (ETIMEOUT): try again in a few minutes",
    });
  });

  it('stops serving a verified domain whose records are gone, once its account checks it again', async () => {
    records.cname['shop.example.tn'] = [URL_HOST];
    await service.add(ACCOUNT, FN, 'shop.example.tn');
    records.cname = {};

    expect(await service.verify(ACCOUNT, FN, 'shop.example.tn')).toMatchObject({ status: 'pending', verifiedAt: null });
    expect(await service.forHost('shop.example.tn')).toBeNull();
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'custom_domain.unverify' }));
  });

  it("leaves a domain another account proved first to that account: this one stays pending, and says why", async () => {
    rows.push({ id: 'other', domain: 'shop.example.tn', accountId: '999999999999', functionId: 'f-other', token: 'x'.repeat(32), status: DomainStatus.VERIFIED } as CustomDomain);
    records.cname['shop.example.tn'] = [URL_HOST];

    const added = await service.add(ACCOUNT, FN, 'shop.example.tn');

    expect(added).toMatchObject({ status: 'pending', checkError: 'Another account serves shop.example.tn: it proved the domain first' });
    await expect(service.verify(ACCOUNT, FN, 'shop.example.tn')).rejects.toBeInstanceOf(ConflictException);
    expect((await service.forHost('shop.example.tn'))?.accountId).toBe('999999999999');
  });

  it.each([
    ['no domain', 'localhost', 'A domain has two labels at least, such as example.tn'],
    ['an address', '192.0.2.1', 'An IP address is no domain: give a name, such as api.example.tn'],
    ['a name under the function domain', 'x.fn.example.tn', "x.fn.example.tn is under fn.example.tn, where FF's own URLs are"],
    ["a name under the sites' domain", 'x.site.example.tn', "x.site.example.tn is under site.example.tn, where FF's own sites are"],
    ['a name no authority certifies, in production', 'shop.example.test', 'shop.example.test is under .test, which no certificate authority certifies'],
  ])('refuses %s', async (_case, domain, problem) => {
    await expect(service.add(ACCOUNT, FN, domain)).rejects.toThrow(new BadRequestException(problem));
    expect(rows).toEqual([]);
  });

  it("refuses a domain over the plan's limit, and one the account has already", async () => {
    limit = 1;
    await service.add(ACCOUNT, FN, 'shop.example.tn');

    await expect(service.add(ACCOUNT, FN, 'blog.example.tn')).rejects.toThrow('The Beta plan allows 1 custom domains, and the account has 1: remove one first');
    limit = 5;
    await expect(service.add(ACCOUNT, FN, 'SHOP.example.tn')).rejects.toBeInstanceOf(ConflictException);
  });

  it("lists and removes the URL's domains, and finds no other account's", async () => {
    await service.add(ACCOUNT, FN, 'shop.example.tn');
    await service.add(ACCOUNT, FN, 'blog.example.tn');

    expect((await service.list(ACCOUNT, FN)).map((domain) => domain.domain)).toEqual(['shop.example.tn', 'blog.example.tn']);
    await service.remove(ACCOUNT, FN, 'shop.example.tn');
    expect((await service.list(ACCOUNT, FN)).map((domain) => domain.domain)).toEqual(['blog.example.tn']);
    expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'custom_domain.remove', details: { domain: 'shop.example.tn' } }));
    await expect(service.remove(ACCOUNT, FN, 'shop.example.tn')).rejects.toThrow('The function\'s URL has no domain shop.example.tn');
    await expect(service.list('999999999999', FN)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("a bucket's site", () => {
    it("adds a domain to the site, proved by a CNAME to the site's host, and serves it with its bucket", async () => {
      const added = await service.addToSite(ACCOUNT, 'docs', 'Docs.Example.TN');

      expect(added).toMatchObject({ domain: 'docs.example.tn', bucket: 'docs', status: 'pending' });
      expect(added.records.cname).toEqual([{ type: 'CNAME', name: 'docs.example.tn', value: SITE_HOST }]);
      expect(audit.record).toHaveBeenCalledWith({ accountId: ACCOUNT, action: 'custom_domain.add', resource: 'bucket:docs', details: { domain: 'docs.example.tn' } });
      expect(await service.forHost('docs.example.tn')).toBeNull();

      records.cname['docs.example.tn'] = [SITE_HOST];
      expect(await service.verifyForSite(ACCOUNT, 'docs', 'docs.example.tn')).toMatchObject({ status: 'verified' });
      expect(await service.forHost('docs.example.tn')).toMatchObject({ functionId: null, bucket: { name: 'docs' } });
      expect((await service.listForSite(ACCOUNT, 'docs')).map((domain) => domain.domain)).toEqual(['docs.example.tn']);
      expect(await service.list(ACCOUNT, FN)).toEqual([]);
    });

    it("doesn't take a CNAME to a function's URL as a site's proof, nor the other way", async () => {
      records.cname['docs.example.tn'] = [URL_HOST];
      records.cname['shop.example.tn'] = [SITE_HOST];

      expect(await service.addToSite(ACCOUNT, 'docs', 'docs.example.tn')).toMatchObject({ status: 'pending' });
      expect(await service.add(ACCOUNT, FN, 'shop.example.tn')).toMatchObject({ status: 'pending' });
    });

    it('adds no domain to a bucket that is no site, nor to a bucket the account has not', async () => {
      await expect(service.addToSite(ACCOUNT, 'data', 'data.example.tn')).rejects.toThrow('The bucket "data" is no site: set its website configuration first');
      await expect(service.listForSite(ACCOUNT, 'nope')).rejects.toThrow('The account has no bucket named "nope"');
      await expect(service.listForSite('999999999999', 'docs')).rejects.toBeInstanceOf(NotFoundException);
      expect(rows).toEqual([]);
    });

    it('keeps a former site\'s domains its own, to read and remove', async () => {
      await service.addToSite(ACCOUNT, 'docs', 'docs.example.tn');
      buckets[0].website = null;

      expect((await service.listForSite(ACCOUNT, 'docs')).map((domain) => domain.domain)).toEqual(['docs.example.tn']);
      await service.removeFromSite(ACCOUNT, 'docs', 'docs.example.tn');
      expect(rows).toEqual([]);
    });

    it("keeps a domain in an account once, for a URL or a site, and counts both kinds against the plan's limit", async () => {
      await service.add(ACCOUNT, FN, 'shop.example.tn');

      await expect(service.addToSite(ACCOUNT, 'docs', 'shop.example.tn')).rejects.toThrow(
        new ConflictException("The account has shop.example.tn already: a domain serves one function's URL or one site"),
      );
      limit = 1;
      await expect(service.addToSite(ACCOUNT, 'docs', 'docs.example.tn')).rejects.toThrow('The Beta plan allows 1 custom domains, and the account has 1: remove one first');
    });

    it("removes the site's domains, and only its own", async () => {
      await service.add(ACCOUNT, FN, 'shop.example.tn');
      await service.addToSite(ACCOUNT, 'docs', 'docs.example.tn');

      await expect(service.removeFromSite(ACCOUNT, 'docs', 'shop.example.tn')).rejects.toThrow('The site docs has no domain shop.example.tn');
      await service.removeFromSite(ACCOUNT, 'docs', 'docs.example.tn');
      expect(audit.record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'custom_domain.remove', resource: 'bucket:docs' }));
      expect(rows.map((row) => row.domain)).toEqual(['shop.example.tn']);
    });
  });
});

/**
 * L2: customers' own domains on a real PostgreSQL: a domain in an account once,
 * verified in one account at most however many add it, gone with its URL and
 * its function; and every plan with its limit on them. Each run works in a
 * scratch database, dropped afterwards.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { FunctionUrl, UrlAuthType } from '../functions/entities/function-url.entity';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { parsePlanLimits } from '../plans/plan-limits';
import { plan } from '../plans/test-fixtures';
import { CustomDomain, DomainStatus } from './custom-domain.entity';
import { CustomDomainsService } from './custom-domains.service';
import { DomainResolver } from './domain-check';
import { FunctionUrlsService } from './function-urls.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;
const ONE = '400000000031';
const TWO = '400000000032';

run("customers' domains, in the database (L2)", () => {
  let db: ScratchDatabase;
  let domains: CustomDomainsService;
  /** Each name's CNAME target, as the DNS would answer. */
  const cnames: Record<string, string> = {};
  const resolver: DomainResolver = { cname: async (name) => (cnames[name] ? [cnames[name]] : []), txt: async () => [], addresses: async () => [] };
  const config = {
    getOrThrow: (key: string) => ({ 'functionUrls.base': 'https://fn.example.tn', 'functionUrls.edgeAddresses': [] })[key],
    get: () => 'production',
  } as unknown as ConfigService;

  /** A function of the account, with its URL; its host, for CNAMEs. */
  const withUrl = async (accountId: string, name: string, urlId: string) => {
    const fn = await db.dataSource.getRepository(Function).save({
      accountId,
      name,
      runtime: Runtime.NODEJS,
      code: 'exports.handler = async () => 1;',
      memory: 128,
      timeout: 5,
      status: FunctionStatus.ACTIVE,
    });
    await db.dataSource.getRepository(FunctionUrl).insert({ functionId: fn.id, accountId, urlId, authType: UrlAuthType.NONE });
    return { id: fn.id, host: `${urlId}.fn.example.tn` };
  };

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    await db.dataSource.getRepository(Account).save([
      { id: ONE, name: 'One', planId: 'beta', status: AccountStatus.ACTIVE },
      { id: TWO, name: 'Two', planId: 'beta', status: AccountStatus.ACTIVE },
    ]);
    const urlRows = db.dataSource.getRepository(FunctionUrl);
    // Only what the domains need of the URLs: their account's URL, else 404.
    const urls = { urlOf: async (accountId: string, functionId: string) => urlRows.findOneByOrFail({ accountId, functionId }) } as unknown as FunctionUrlsService;
    domains = new CustomDomainsService(
      db.dataSource.getRepository(CustomDomain),
      urls,
      { forAccount: async () => plan() } as never,
      { record: async () => undefined } as never,
      config,
      resolver,
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('gives every plan its limit on domains: the beta plan 5, read as valid', async () => {
    const beta = await db.dataSource.getRepository(Plan).findOneByOrFail({ id: 'beta' });

    expect(parsePlanLimits('beta', beta.limits).customDomains).toBe(5);
  });

  it('verifies a domain in one account at most, though both add it: the first to prove it keeps it', async () => {
    const [a, b] = [await withUrl(ONE, 'shop-one', 'a'.repeat(32)), await withUrl(TWO, 'shop-two', 'b'.repeat(32))];
    await domains.add(ONE, a.id, 'shop.example.tn');
    await domains.add(TWO, b.id, 'shop.example.tn');

    cnames['shop.example.tn'] = a.host;
    expect((await domains.verify(ONE, a.id, 'shop.example.tn')).status).toBe(DomainStatus.VERIFIED);
    // The domain's owner points it to the other account's URL: that one still can't take it.
    cnames['shop.example.tn'] = b.host;
    await expect(domains.verify(TWO, b.id, 'shop.example.tn')).rejects.toBeInstanceOf(ConflictException);

    const rows = await db.dataSource.getRepository(CustomDomain).find({ where: { domain: 'shop.example.tn' }, order: { accountId: 'ASC' } });
    expect(rows.map((row) => [row.accountId, row.status])).toEqual([
      [ONE, DomainStatus.VERIFIED],
      [TWO, DomainStatus.PENDING],
    ]);
    expect((await domains.forHost('shop.example.tn'))?.functionId).toBe(a.id);
  });

  it('keeps a domain in an account once, even for two of its functions', async () => {
    const [a, b] = [await withUrl(ONE, 'blog-one', 'c'.repeat(32)), await withUrl(ONE, 'blog-two', 'd'.repeat(32))];
    await domains.add(ONE, a.id, 'blog.example.tn');

    await expect(domains.add(ONE, b.id, 'blog.example.tn')).rejects.toBeInstanceOf(ConflictException);
  });

  it('deletes the domains with their URL, and with their function', async () => {
    const [a, b] = [await withUrl(ONE, 'gone-url', 'e'.repeat(32)), await withUrl(ONE, 'gone-fn', 'f'.repeat(32))];
    await domains.add(ONE, a.id, 'one.example.tn');
    await domains.add(ONE, b.id, 'two.example.tn');

    await db.dataSource.getRepository(FunctionUrl).delete({ functionId: a.id });
    await db.dataSource.getRepository(Function).delete({ id: b.id });

    expect(await db.dataSource.getRepository(CustomDomain).countBy([{ domain: 'one.example.tn' }, { domain: 'two.example.tn' }])).toBe(0);
  });
});

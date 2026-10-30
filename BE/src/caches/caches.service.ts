import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isIP } from 'node:net';
import { In, Not, QueryFailedError, Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { CacheSettings } from '../config/configuration';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { CACHE_SERVER, CacheServer, CacheSpec, CacheUse } from './cache-server';
import { newPassword, newServerName, passwordSha256 } from './cache-names';
import { Cache, CacheStatus } from './cache.entity';
import { CacheView, CacheWithPassword, CreateCacheDto } from './dto/cache.dto';

/** PostgreSQL's unique_violation: the account has a cache of that name, or another took the port first. */
const UNIQUE_VIOLATION = '23505';

export const NO_CACHE_SERVER = "This FF has no server for customers' caches (FF_CACHE_HOST)";

/** What answers a cache's connections. */
export const ENGINE = 'Valkey 9.1';

/**
 * Customers' caches (ADR 0013): each a Valkey process of its own on the server
 * of customers' caches, at a port of its own, with the plan's memory and a
 * password FF makes, shows once in the cache's address and never keeps. The
 * plan limits how many an account has; each change goes to its audit log. A
 * suspended account's caches refuse its logins, their keys kept; a closed
 * account's go at its data deletion date (RetentionService).
 */
@Injectable()
export class CachesService {
  private readonly logger = new Logger(CachesService.name);
  private readonly settings: CacheSettings | null;

  constructor(
    @InjectRepository(Cache) private readonly caches: Repository<Cache>,
    @Inject(CACHE_SERVER) private readonly server: CacheServer | null,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.settings = config.get<CacheSettings | null>('cache') ?? null;
  }

  /** The account's caches, by name, with their memory used and connections now, as far as the server answers. */
  async list(accountId: string): Promise<CacheView[]> {
    const rows = await this.caches.find({ where: { accountId, status: Not(CacheStatus.DELETING) }, order: { name: 'ASC' } });
    const use = await this.useOf(rows);
    return rows.map((row) => this.view(row, use.get(row.serverName)));
  }

  /** The account's caches as the operator's page shows them: each one's name on the server too, which FF's own tools name. */
  async forOperator(accountId: string): Promise<Array<CacheView & { serverName: string }>> {
    const rows = await this.caches.find({ where: { accountId, status: Not(CacheStatus.DELETING) }, order: { name: 'ASC' } });
    const use = await this.useOf(rows);
    return rows.map((row) => ({ ...this.view(row, use.get(row.serverName)), serverName: row.serverName }));
  }

  async get(accountId: string, name: string): Promise<CacheView> {
    const row = await this.cacheOf(accountId, name);
    return this.view(row, (await this.useOf([row])).get(row.serverName));
  }

  /**
   * A new cache, within the plan: counted under a lock on the account, so that
   * two at once can't pass the plan together, its port the first free one of
   * the server's. Its password is in this answer only. A failure on the server
   * undoes what was made there.
   */
  async create(accountId: string, dto: CreateCacheDto): Promise<CacheWithPassword> {
    const server = this.serverOrRefuse();
    const settings = this.settings as CacheSettings;
    const plan = await this.plans.forAccount(accountId);
    const password = newPassword();
    let row: Cache;
    try {
      row = await this.caches.manager.transaction(async (manager) => {
        await manager.findOne(Account, { where: { id: accountId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
        const count = await manager.countBy(Cache, { accountId });
        if (count >= plan.limits.caches) {
          throw new BadRequestException(`The ${plan.name} plan allows ${plan.limits.caches} cache${plan.limits.caches === 1 ? '' : 's'}, and the account has ${count}: delete one first`);
        }
        // The server's ports, one cache's each: the first free one, under a lock every new cache takes.
        await manager.query(`SELECT pg_advisory_xact_lock(hashtext('caches.port'))`);
        const [free] = await manager.query<Array<{ port: number | null }>>(
          `SELECT min(p)::int AS port FROM generate_series($1::int, $2::int) AS p WHERE NOT EXISTS (SELECT 1 FROM caches WHERE port = p)`,
          [settings.ports.first, settings.ports.last],
        );
        if (free?.port === null || free?.port === undefined) throw new ServiceUnavailableException("Customers' cache server has no port left: the operator adds a server");
        return manager.save(
          Cache,
          manager.create(Cache, {
            accountId,
            name: dto.name,
            serverName: newServerName(),
            port: free.port,
            memoryMb: plan.limits.cacheMb,
            passwordSha256: passwordSha256(password),
            status: CacheStatus.CREATING,
          }),
        );
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) {
        throw new ConflictException(`The account has a cache named "${dto.name}" already`);
      }
      throw error;
    }
    try {
      await server.put(row.serverName, this.specOf(row, true));
    } catch (error) {
      await server.remove(row.serverName).catch((cleanup: unknown) => this.logger.error(`Could not undo cache ${row.serverName} on the server: ${describeError(cleanup)}`));
      await this.caches.delete({ id: row.id });
      this.logger.error(`Could not make cache ${row.serverName} of account ${accountId} on the server: ${describeError(error)}`);
      throw new ServiceUnavailableException("Customers' cache server couldn't make the cache: nothing was made, try again in a moment");
    }
    row.status = CacheStatus.ACTIVE;
    row.passwordSetAt = new Date();
    await this.caches.update({ id: row.id }, { status: row.status, passwordSetAt: row.passwordSetAt });
    await this.audit.record({ accountId, action: 'cache.create', resource: `cache:${row.name}`, details: { cache: row.serverName, port: row.port, memoryMb: row.memoryMb } });
    await this.openPolicy(accountId);
    return this.withPassword(row, password);
  }

  /** A new password, in this answer only; the connections under way keep theirs, as an ElastiCache AUTH token's rotation does. */
  async resetPassword(accountId: string, name: string): Promise<CacheWithPassword> {
    const server = this.serverOrRefuse();
    const row = await this.cacheOf(accountId, name);
    if (row.status === CacheStatus.CREATING) throw new ConflictException(`Cache ${row.name} is still being made`);
    const password = newPassword();
    const hash = passwordSha256(password);
    await this.onServer(() => server.put(row.serverName, { ...this.specOf(row, row.status === CacheStatus.ACTIVE), passwordSha256: hash }));
    row.passwordSha256 = hash;
    row.passwordSetAt = new Date();
    await this.caches.update({ id: row.id }, { passwordSha256: hash, passwordSetAt: row.passwordSetAt });
    await this.audit.record({ accountId, action: 'cache.password', resource: `cache:${row.name}` });
    return this.withPassword(row, password);
  }

  /** The cache gone from the server, its connections ended, its keys with it; then its row. */
  async remove(accountId: string, name: string): Promise<void> {
    const server = this.serverOrRefuse();
    const row = await this.cacheOf(accountId, name);
    await this.caches.update({ id: row.id }, { status: CacheStatus.DELETING });
    await this.onServer(() => server.remove(row.serverName));
    await this.caches.delete({ id: row.id });
    await this.audit.record({ accountId, action: 'cache.delete', resource: `cache:${row.name}`, details: { cache: row.serverName } });
  }

  /** A suspended or closed account: its caches' users can't log in, and their connections end; their keys stay. Each on its own: a failure is logged. */
  async suspendAccount(accountId: string): Promise<void> {
    await this.eachOf(accountId, [CacheStatus.ACTIVE], 'suspend', async (server, row) => {
      await server.put(row.serverName, this.specOf(row, false));
      await this.caches.update({ id: row.id }, { status: CacheStatus.SUSPENDED });
    });
  }

  /** A reactivated account: its caches' users log in again, their keys as they were; unless the account isn't active. */
  async reactivateAccount(accountId: string): Promise<void> {
    if (!(await this.loginAllowed(accountId))) return;
    await this.eachOf(accountId, [CacheStatus.SUSPENDED], 'reactivate', async (server, row) => {
      await server.put(row.serverName, this.specOf(row, true));
      await this.caches.update({ id: row.id }, { status: CacheStatus.ACTIVE });
    });
  }

  /** A closed account's caches, at its data deletion date: every one deleted, then its row. Answers how many; a failure stops it, for the next run. */
  async deleteAll(accountId: string): Promise<number> {
    const rows = await this.caches.find({ where: { accountId } });
    if (rows.length === 0) return 0;
    const server = this.serverOrRefuse();
    for (const row of rows) {
      await server.remove(row.serverName);
      await this.caches.delete({ id: row.id });
    }
    return rows.length;
  }

  /** The cache as the server must have it, its user let in or kept out: its password's SHA-256 the one FF keeps. */
  private specOf(row: Cache, enabled: boolean): CacheSpec {
    return { port: row.port, memoryMb: row.memoryMb, passwordSha256: row.passwordSha256, enabled };
  }

  /** Whether the account's caches' users may log in: an active account's, as its status alone says; FF's switch of its databases, buckets and queues leaves caches be. */
  private async loginAllowed(accountId: string): Promise<boolean> {
    const account = await this.caches.manager.findOneBy(Account, { id: accountId });
    return account?.status === AccountStatus.ACTIVE;
  }

  private serverOrRefuse(): CacheServer {
    if (!this.server || !this.settings) throw new ServiceUnavailableException(NO_CACHE_SERVER);
    return this.server;
  }

  private async cacheOf(accountId: string, name: string): Promise<Cache> {
    const row = await this.caches.findOne({ where: { name, accountId } });
    if (!row || row.status === CacheStatus.DELETING) throw new NotFoundException(`The account has no cache ${name}`);
    return row;
  }

  /** A change on the server; its failure is the server's, said as such, and logged. */
  private async onServer(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(`Customers' cache server failed: ${describeError(error)}`);
      throw new ServiceUnavailableException("Customers' cache server couldn't do it: try again in a moment");
    }
  }

  private async eachOf(accountId: string, statuses: CacheStatus[], what: string, work: (server: CacheServer, row: Cache) => Promise<void>): Promise<void> {
    const rows = await this.caches.find({ where: { accountId, status: In(statuses) } });
    if (rows.length === 0 || !this.server) return;
    for (const row of rows) {
      try {
        await work(this.server, row);
      } catch (error) {
        this.logger.error(`Could not ${what} cache ${row.serverName} of account ${accountId}: ${describeError(error)}`);
      }
    }
  }

  /** Every function of the account reaches the server from now on: its policy written again, with the rule that opens the server to them. */
  private async openPolicy(accountId: string): Promise<void> {
    try {
      await this.plans.withTenant(accountId, (tenant) => this.orchestrator.applyTenantLimits(accountId, tenant));
    } catch (error) {
      // The account's next deploy writes it anyway.
      this.logger.warn(`Could not write account ${accountId}'s network policy again: ${describeError(error)}`);
    }
  }

  /** The caches' use now, or nothing when the server can't say: a list shows them anyway. */
  private async useOf(rows: Cache[]): Promise<Map<string, CacheUse>> {
    if (!this.server || rows.length === 0) return new Map();
    try {
      return await this.server.use(rows.map((row) => row.serverName));
    } catch (error) {
      this.logger.warn(`Could not read the caches' use from the server: ${describeError(error)}`);
      return new Map();
    }
  }

  /** The server's host as a URL names it: an IPv6 address in brackets. */
  private urlHost(): string {
    const host = this.settings?.host ?? '';
    return isIP(host) === 6 ? `[${host}]` : host;
  }

  private view(row: Cache, use: CacheUse | undefined): CacheView {
    return {
      name: row.name,
      status: row.status,
      host: this.settings?.host ?? '',
      port: row.port,
      address: `rediss://default@${this.urlHost()}:${row.port}`,
      memoryMb: row.memoryMb,
      bytesUsedForCache: use?.bytesUsedForCache ?? null,
      currConnections: use?.currConnections ?? null,
      engine: ENGINE,
      passwordSetAt: row.passwordSetAt,
      createdAt: row.createdAt,
    };
  }

  private withPassword(row: Cache, password: string): CacheWithPassword {
    return { ...this.view(row, undefined), password, url: `rediss://default:${password}@${this.urlHost()}:${row.port}` };
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isIP } from 'node:net';
import { In, Not, QueryFailedError, Repository } from 'typeorm';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { DataDbSettings } from '../config/configuration';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { PlanLimits } from '../plans/plan-limits';
import { PlansService } from '../plans/plans.service';
import { DATA_SERVER, DataServer, DatabaseUse } from './data-server';
import { newPassword, newServerName } from './database-names';
import { Database, DatabaseStatus } from './database.entity';
import { CreateDatabaseDto, DatabaseView, DatabaseWithPassword } from './dto/database.dto';
import { scramVerifier } from './scram';

/** PostgreSQL's unique_violation: the account has a database of that name. */
const UNIQUE_VIOLATION = '23505';

export const NO_DATA_SERVER = "This FF has no server for customers' databases (FF_DATA_DB_HOST)";

/**
 * Customers' databases (ADR 0008): each a database and its user on the server
 * of customers' databases, with an opaque name, a password FF makes, shows
 * once and never keeps, and the plan's connection limit. The plan limits how
 * many an account has; each change goes to its audit log. A suspended or
 * closed account's users can't log in; a closed account's databases go at its
 * data deletion date (RetentionService).
 */
@Injectable()
export class DatabasesService {
  private readonly logger = new Logger(DatabasesService.name);
  private readonly settings: DataDbSettings | null;

  constructor(
    @InjectRepository(Database) private readonly databases: Repository<Database>,
    @Inject(DATA_SERVER) private readonly server: DataServer | null,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.settings = config.get<DataDbSettings | null>('dataDb') ?? null;
  }

  /** The account's databases, by name, with their size and sessions now, as far as the server answers. */
  async list(accountId: string): Promise<DatabaseView[]> {
    const rows = await this.databases.find({ where: { accountId, status: Not(DatabaseStatus.DELETING) }, order: { name: 'ASC' } });
    const limits = (await this.plans.forAccount(accountId)).limits;
    const use = await this.useOf(rows);
    return rows.map((row) => this.view(row, limits, use.get(row.dbName)));
  }

  async get(accountId: string, id: string): Promise<DatabaseView> {
    const row = await this.databaseOf(accountId, id);
    const limits = (await this.plans.forAccount(accountId)).limits;
    return this.view(row, limits, (await this.useOf([row])).get(row.dbName));
  }

  /**
   * A new database and its user, within the plan: counted under a lock on the
   * account, so that two at once can't pass the plan together. Its password is
   * in this answer only. A failure on the server undoes what was made there.
   */
  async create(accountId: string, dto: CreateDatabaseDto): Promise<DatabaseWithPassword> {
    const server = this.serverOrRefuse();
    const account = await this.databases.manager.findOneBy(Account, { id: accountId });
    if (account?.storageDisabledAt) throw new ForbiddenException(`FF turned this account's databases and buckets off: ${account.storageDisabledReason}`);
    const plan = await this.plans.forAccount(accountId);
    let row: Database;
    try {
      row = await this.databases.manager.transaction(async (manager) => {
        await manager.findOne(Account, { where: { id: accountId }, select: { id: true }, lock: { mode: 'pessimistic_write' } });
        const count = await manager.countBy(Database, { accountId });
        if (count >= plan.limits.databases) {
          throw new BadRequestException(`The ${plan.name} plan allows ${plan.limits.databases} database${plan.limits.databases === 1 ? '' : 's'}, and the account has ${count}: delete one first`);
        }
        return manager.save(Database, manager.create(Database, { accountId, name: dto.name, dbName: newServerName(), status: DatabaseStatus.CREATING }));
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string })?.code === UNIQUE_VIOLATION) {
        throw new ConflictException(`The account has a database named "${dto.name}" already`);
      }
      throw error;
    }
    const password = newPassword();
    try {
      await server.create(row.dbName, scramVerifier(password), plan.limits.databaseConnections);
    } catch (error) {
      await server.drop(row.dbName).catch((cleanup: unknown) => this.logger.error(`Could not undo database ${row.dbName} on the server: ${describeError(cleanup)}`));
      await this.databases.delete({ id: row.id });
      this.logger.error(`Could not make database ${row.dbName} of account ${accountId} on the server: ${describeError(error)}`);
      throw new ServiceUnavailableException("Customers' database server couldn't make the database: nothing was made, try again in a moment");
    }
    row.status = DatabaseStatus.ACTIVE;
    row.passwordSetAt = new Date();
    await this.databases.update({ id: row.id }, { status: row.status, passwordSetAt: row.passwordSetAt });
    await this.audit.record({ accountId, action: 'database.create', resource: `database:${row.id}`, details: { name: row.name, database: row.dbName } });
    await this.openPolicy(accountId);
    return this.withPassword(row, plan.limits, password);
  }

  /** A new password, in this answer only; the sessions under way keep theirs, as RDS's do. */
  async resetPassword(accountId: string, id: string): Promise<DatabaseWithPassword> {
    const server = this.serverOrRefuse();
    const row = await this.databaseOf(accountId, id);
    if (row.status === DatabaseStatus.CREATING) throw new ConflictException(`Database ${row.name} is still being made`);
    const password = newPassword();
    await this.onServer(() => server.setPassword(row.dbName, scramVerifier(password)));
    row.passwordSetAt = new Date();
    await this.databases.update({ id: row.id }, { passwordSetAt: row.passwordSetAt });
    await this.audit.record({ accountId, action: 'database.password', resource: `database:${row.id}`, details: { name: row.name } });
    return this.withPassword(row, (await this.plans.forAccount(accountId)).limits, password);
  }

  /** The database and its user, gone from the server, its sessions ended, then its row. */
  async remove(accountId: string, id: string): Promise<void> {
    const server = this.serverOrRefuse();
    const row = await this.databaseOf(accountId, id);
    await this.databases.update({ id: row.id }, { status: DatabaseStatus.DELETING });
    await this.onServer(() => server.drop(row.dbName));
    await this.databases.delete({ id: row.id });
    await this.audit.record({ accountId, action: 'database.delete', resource: `database:${row.id}`, details: { name: row.name, database: row.dbName } });
  }

  /** A suspended or closed account: its users can't log in, and their sessions end (D12). Each on its own: a failure is logged. */
  async suspendAccount(accountId: string): Promise<void> {
    await this.eachOf(accountId, [DatabaseStatus.ACTIVE, DatabaseStatus.READ_ONLY], 'suspend', async (server, row) => {
      await server.setLogin(row.dbName, false);
      await this.databases.update({ id: row.id }, { status: DatabaseStatus.SUSPENDED });
    });
  }

  /**
   * A reactivated account, or its storage on again: its users log in again, read-write until the next hourly sample
   * finds one past the plan; unless the account isn't active, or FF turned its storage off.
   */
  async reactivateAccount(accountId: string): Promise<void> {
    if (!(await this.loginAllowed(accountId))) return;
    await this.eachOf(accountId, [DatabaseStatus.SUSPENDED], 'reactivate', async (server, row) => {
      await server.setLogin(row.dbName, true);
      await server.setReadOnly(row.dbName, false);
      await this.databases.update({ id: row.id }, { status: DatabaseStatus.ACTIVE });
    });
  }

  /** The account's databases as its status and its storage switch say: their users let in, or kept out. */
  async applyAccess(accountId: string): Promise<void> {
    if (await this.loginAllowed(accountId)) await this.reactivateAccount(accountId);
    else await this.suspendAccount(accountId);
  }

  /** A closed account's databases, at its data deletion date: every one dropped, then its row. Answers how many; a failure stops it, for the next run. */
  async deleteAll(accountId: string): Promise<number> {
    const rows = await this.databases.find({ where: { accountId } });
    if (rows.length === 0) return 0;
    const server = this.serverOrRefuse();
    for (const row of rows) {
      await server.drop(row.dbName);
      await this.databases.delete({ id: row.id });
    }
    return rows.length;
  }

  /** Whether the account's databases' users may log in: an active account whose storage FF hasn't turned off. */
  private async loginAllowed(accountId: string): Promise<boolean> {
    const account = await this.databases.manager.findOneBy(Account, { id: accountId });
    return account?.status === AccountStatus.ACTIVE && account.storageDisabledAt === null;
  }

  private serverOrRefuse(): DataServer {
    if (!this.server || !this.settings) throw new ServiceUnavailableException(NO_DATA_SERVER);
    return this.server;
  }

  private async databaseOf(accountId: string, id: string): Promise<Database> {
    const row = await this.databases.findOne({ where: { id, accountId } });
    if (!row || row.status === DatabaseStatus.DELETING) throw new NotFoundException(`Database ${id} not found`);
    return row;
  }

  /** A change on the server; its failure is the server's, said as such, and logged. */
  private async onServer(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.error(`Customers' database server failed: ${describeError(error)}`);
      throw new ServiceUnavailableException("Customers' database server couldn't do it: try again in a moment");
    }
  }

  private async eachOf(accountId: string, statuses: DatabaseStatus[], what: string, work: (server: DataServer, row: Database) => Promise<void>): Promise<void> {
    const rows = await this.databases.find({ where: { accountId, status: In(statuses) } });
    if (rows.length === 0 || !this.server) return;
    for (const row of rows) {
      try {
        await work(this.server, row);
      } catch (error) {
        this.logger.error(`Could not ${what} database ${row.dbName} of account ${accountId}: ${describeError(error)}`);
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

  /** The databases' use now, or nothing when the server can't say: a list shows them anyway. */
  private async useOf(rows: Database[]): Promise<Map<string, DatabaseUse>> {
    if (!this.server || rows.length === 0) return new Map();
    try {
      return await this.server.use(rows.map((row) => row.dbName));
    } catch (error) {
      this.logger.warn(`Could not read the databases' use from the server: ${describeError(error)}`);
      return new Map();
    }
  }

  /** The server's host as a URL names it: an IPv6 address in brackets. */
  private urlHost(): string {
    const host = this.settings?.host ?? '';
    return isIP(host) === 6 ? `[${host}]` : host;
  }

  private view(row: Database, limits: PlanLimits, use: DatabaseUse | undefined): DatabaseView {
    const host = this.settings?.host ?? '';
    const port = this.settings?.port ?? 5432;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      host,
      port,
      database: row.dbName,
      user: row.dbName,
      connectionUrl: `postgresql://${row.dbName}@${this.urlHost()}:${port}/${row.dbName}?sslmode=require`,
      sizeBytes: use ? Number(use.sizeBytes) : null,
      connections: use?.connections ?? null,
      connectionLimit: limits.databaseConnections,
      storageLimitMb: limits.databaseStorageMb,
      passwordSetAt: row.passwordSetAt,
      createdAt: row.createdAt,
    };
  }

  private withPassword(row: Database, limits: PlanLimits, password: string): DatabaseWithPassword {
    const view = this.view(row, limits, undefined);
    return { ...view, password, connectionString: `postgresql://${row.dbName}:${password}@${this.urlHost()}:${view.port}/${row.dbName}?sslmode=require` };
  }
}

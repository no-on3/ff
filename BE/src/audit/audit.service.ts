import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, LessThan, Repository } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { describeError } from '../common/describe-error';
import { Actor, currentRequest } from '../common/request-context';
import { AuditEntry } from './audit-entry.entity';

/** Every action the audit log records (P-17). Credit, status and /admin actions come with their tasks. */
export type AuditAction =
  | 'account.create'
  | 'account.update'
  | 'account.plan'
  | 'function.create'
  | 'function.update'
  | 'function.delete'
  | 'function.scaling'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'member.invite'
  | 'member.invitation_cancel'
  | 'member.join'
  | 'member.role'
  | 'member.remove'
  | 'settings.update';

export interface AuditEvent {
  /** null for an action on no account. */
  accountId: string | null;
  action: AuditAction;
  resource?: string;
  details?: Record<string, unknown>;
  /** By default, the request's caller; outside a request, FF itself. */
  actor?: Actor;
  /** By default, the request's address. */
  ip?: string;
  /** By default, the request's ID. */
  requestId?: string;
}

/** The actor of what FF does on its own: timers, jobs. */
export const SYSTEM: Actor = { id: 'system', label: 'FF' };

/** Which operator actions GET /admin/audit-log lists (P-76): every given part must match. */
export interface OperatorActionFilter {
  /** Part of the operator's e-mail, in any case. */
  operator?: string;
  accountId?: string;
  action?: string;
  /** From this instant, included. */
  from?: Date;
  /** Until this instant, excluded. */
  to?: Date;
}

/** The actor of every operator action: operator:<Keycloak ID> (P-70). */
export const OPERATOR_ACTOR = 'operator:';

/** Text to match as itself in LIKE: its wildcards and the escape character escaped. */
const literal = (text: string) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

export interface AuditPage {
  entries: AuditEntry[];
  /** The `before` of the next page, older; null on the last one. */
  next: string | null;
}

/**
 * The audit log (client-readiness plan, P-17): who changed what in an
 * account, when, and from where. The services record each change as they
 * make it; the request context gives the caller, the address and the
 * request's ID.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectRepository(AuditEntry) private readonly entries: Repository<AuditEntry>) {}

  /**
   * Records an event. Through `manager`, in the caller's transaction, so the
   * change and its record stand or fall together. Without one, on its own: a
   * failure is logged as an error, and not thrown, since the change is made.
   */
  async record(event: AuditEvent, manager?: EntityManager): Promise<void> {
    const context = currentRequest();
    const actor = event.actor ?? context?.actor ?? SYSTEM;
    // TypeORM's partial type can't follow a free-form jsonb column: the entity says what it holds.
    const row = {
      accountId: event.accountId,
      actor: actor.id,
      actorLabel: actor.label,
      action: event.action,
      resource: event.resource ?? null,
      ip: event.ip ?? context?.ip ?? null,
      requestId: event.requestId ?? context?.requestId ?? null,
      details: event.details ?? null,
    } as QueryDeepPartialEntity<AuditEntry>;
    if (manager) {
      await manager.insert(AuditEntry, row);
      return;
    }
    try {
      await this.entries.insert(row);
    } catch (error) {
      this.logger.error(`Could not record ${event.action} on ${event.resource ?? `account ${event.accountId}`}: ${describeError(error)}`);
    }
  }

  /** GET /admin/audit-log (P-76): the operators' actions, newest first, a page at a time. */
  async operatorActions(filter: OperatorActionFilter, { limit, before }: { limit: number; before?: string }): Promise<AuditPage> {
    const query = this.operatorQuery(filter).orderBy('entry.id', 'DESC').take(limit + 1);
    if (before) query.andWhere('entry.id < :before', { before });
    const entries = await query.getMany();
    const more = entries.length > limit;
    return { entries: entries.slice(0, limit), next: more ? entries[limit - 1].id : null };
  }

  /** The same actions for an export: the newest `cap` of them, and whether there were more. */
  async operatorActionsForExport(filter: OperatorActionFilter, cap: number): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
    const entries = await this.operatorQuery(filter).orderBy('entry.id', 'DESC').take(cap + 1).getMany();
    return { entries: entries.slice(0, cap), truncated: entries.length > cap };
  }

  private operatorQuery(filter: OperatorActionFilter) {
    const query = this.entries.createQueryBuilder('entry').where('entry.actor LIKE :actor', { actor: `${OPERATOR_ACTOR}%` });
    if (filter.operator) query.andWhere(`entry.actorLabel ILIKE :operator ESCAPE '\\'`, { operator: `%${literal(filter.operator)}%` });
    if (filter.accountId) query.andWhere('entry.accountId = :accountId', { accountId: filter.accountId });
    if (filter.action) query.andWhere('entry.action = :action', { action: filter.action });
    if (filter.from) query.andWhere('entry.at >= :from', { from: filter.from });
    if (filter.to) query.andWhere('entry.at < :to', { to: filter.to });
    return query;
  }

  /** GET /audit-log: an account's entries, newest first, a page at a time. */
  async list(accountId: string, { limit, before }: { limit: number; before?: string }): Promise<AuditPage> {
    const entries = await this.entries.find({
      where: { accountId, ...(before ? { id: LessThan(before) } : {}) },
      order: { id: 'DESC' },
      take: limit + 1,
    });
    const more = entries.length > limit;
    return { entries: entries.slice(0, limit), next: more ? entries[limit - 1].id : null };
  }
}

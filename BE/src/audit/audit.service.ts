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

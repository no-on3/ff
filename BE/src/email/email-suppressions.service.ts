import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { EmailSuppression, SuppressionReason } from './email-suppression.entity';
import { identityKey } from './email-names';
import type { IdentityCaller } from './email-identities.service';

/** A page of the list, newest first, and where the next starts; none after the last. */
export interface SuppressionPage {
  suppressions: EmailSuppression[];
  next: string | null;
}

/** What a list is asked for, as SES v2's ListSuppressedDestinations takes it. */
export interface SuppressionQuery {
  reasons?: SuppressionReason[];
  /** Put there at or after it, and before `end`. */
  start?: Date;
  end?: Date;
  /** A page's size: 1,000 at most, as SES's. */
  pageSize?: number;
  /** The token of the page before's end. */
  next?: string;
}

/** A token for the next page: its first row's place, opaque, as SES's are. */
const tokenOf = (offset: number): string => Buffer.from(`ff:${offset}`).toString('base64url');
const offsetOf = (token: string): number | null => {
  const match = /^ff:(\d{1,9})$/.exec(Buffer.from(token, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : null;
};

/**
 * An account's suppression list (ADR 0012), as SES v2 keeps one: no mail of
 * the account goes to an address on it. A hard bounce or a complaint puts an
 * address there; the account puts and takes them too, each in its audit log.
 */
@Injectable()
export class EmailSuppressionsService {
  constructor(
    @InjectRepository(EmailSuppression) private readonly suppressions: Repository<EmailSuppression>,
    private readonly audit: AuditService,
  ) {}

  find(accountId: string, address: string): Promise<EmailSuppression | null> {
    return this.suppressions.findOneBy({ accountId, address: identityKey(address) });
  }

  /** The addresses among these that are on the list: a message's recipients, before it goes. */
  async suppressedOf(accountId: string, addresses: string[]): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const rows = await this.suppressions.query<Array<{ address: string }>>(`SELECT "address" FROM "email_suppressions" WHERE "account_id" = $1 AND "address" = ANY($2)`, [
      accountId,
      addresses.map(identityKey),
    ]);
    return new Set(rows.map((row) => row.address));
  }

  /** A page of the list, the latest put there first. A token that is no page's answers null. */
  async list(accountId: string, query: SuppressionQuery = {}): Promise<SuppressionPage | null> {
    const offset = query.next === undefined ? 0 : offsetOf(query.next);
    if (offset === null) return null;
    const size = Math.min(Math.max(query.pageSize ?? 1000, 1), 1000);
    const builder = this.suppressions.createQueryBuilder('s').where('s.accountId = :accountId', { accountId });
    if (query.reasons?.length) builder.andWhere('s.reason IN (:...reasons)', { reasons: query.reasons });
    if (query.start) builder.andWhere('s.updatedAt >= :start', { start: query.start });
    if (query.end) builder.andWhere('s.updatedAt < :end', { end: query.end });
    const rows = await builder.orderBy('s.updatedAt', 'DESC').addOrderBy('s.address', 'ASC').offset(offset).limit(size + 1).getMany();
    return { suppressions: rows.slice(0, size), next: rows.length > size ? tokenOf(offset + size) : null };
  }

  /**
   * The address put on the list, or put there again with this reason: by the
   * account, or by a bounce or a complaint, which names its message. The
   * account's own are in its audit log.
   */
  async put(caller: IdentityCaller | null, accountId: string, address: string, reason: SuppressionReason, cause: { messageId?: string; feedback?: string } = {}): Promise<EmailSuppression> {
    const key = identityKey(address);
    await this.suppressions.query(
      `INSERT INTO "email_suppressions" ("account_id", "address", "reason", "message_id", "feedback", "updated_at") VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT ("account_id", "address") DO UPDATE SET "reason" = EXCLUDED."reason", "message_id" = EXCLUDED."message_id", "feedback" = EXCLUDED."feedback", "updated_at" = now()`,
      [accountId, key, reason, cause.messageId ?? null, cause.feedback ?? null],
    );
    if (caller) await this.record(caller, 'email.suppression.put', key, { reason });
    return (await this.find(accountId, key)) as EmailSuppression;
  }

  /** The address off the list: the account's mail goes to it again. False when it wasn't there. */
  async remove(caller: IdentityCaller, address: string): Promise<boolean> {
    const key = identityKey(address);
    const { affected } = await this.suppressions.delete({ accountId: caller.accountId, address: key });
    if (!affected) return false;
    await this.record(caller, 'email.suppression.delete', key, {});
    return true;
  }

  private record(caller: IdentityCaller, action: 'email.suppression.put' | 'email.suppression.delete', address: string, details: Record<string, unknown>) {
    return this.audit.record({
      accountId: caller.accountId,
      action,
      resource: `email-suppression:${address}`,
      details,
      ...(caller.actor ? { actor: caller.actor } : {}),
      ...(caller.ip ? { ip: caller.ip } : {}),
    });
  }
}

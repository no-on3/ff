import { headerOf, headerParameter, mimeParts } from './email-send';
import { identityKey } from './email-names';

/**
 * What comes back for a return-path domain (ADR 0012), read as mail servers
 * and mailbox providers write it: a delivery status notification (RFC 3464),
 * which says of each recipient whether it failed for good, for now, or is only
 * delayed; or an abuse report, a complaint (RFC 5965, ARF). Which message it
 * was, its return path says, b-<message>@: the address it came back to.
 */

export interface ReportedRecipient {
  address: string;
  /** failed, delayed, delivered, relayed or expanded, as the report's Action says; complained for a complaint. */
  action: string;
  /** The status code, such as 5.1.1: 5 for good, 4 for now. */
  status: string;
  diagnostic: string | null;
}

export interface Report {
  /** The message, by its ID: the return path's b-<id>; null when the report names none of FF's. */
  messageId: string | null;
  kind: 'bounce' | 'complaint' | 'other';
  recipients: ReportedRecipient[];
  /** A complaint's Feedback-Type, such as abuse. */
  feedbackType?: string;
}

const VERP = /\bb-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i;

/** The field groups of a status report's body, each a group's fields by their names in lower case. */
function groupsOf(body: Buffer): Array<Map<string, string>> {
  return body
    .toString('latin1')
    .split(/\r?\n[ \t]*\r?\n/)
    .map((group) => new Map(headerOf(Buffer.from(`${group.trim()}\r\n\r\n`, 'latin1')).fields.map(({ name, value }) => [name, value])))
    .filter((group) => group.size > 0);
}

/** The address of a recipient field: rfc822; orders@shop.tn. */
const recipientOf = (value: string | undefined): string | null => {
  const address = value?.replace(/^\s*rfc822\s*;/i, '').trim().replace(/^<|>$/g, '');
  return address ? identityKey(address) : null;
};

/** A report as FF reads it: whose message, what kind, and what became of each recipient. */
export function readReport(raw: Buffer): Report {
  const { fields } = headerOf(raw);
  const header = (name: string) => fields.find((field) => field.name === name)?.value;
  const to = ['delivered-to', 'x-original-to', 'to'].map(header).find((value) => value !== undefined && VERP.test(value));
  const messageId = VERP.exec(to ?? raw.toString('latin1'))?.[1]?.toLowerCase() ?? null;
  const contentType = header('content-type') ?? '';
  const reportType = /^multipart\/report/i.test(contentType) ? headerParameter(contentType, 'report-type')?.toLowerCase() : undefined;
  const parts = mimeParts(raw);
  const typeOf = (part: (typeof parts)[number]) => (part.fields.find((field) => field.name === 'content-type')?.value ?? '').split(';')[0].trim().toLowerCase();

  if (reportType === 'delivery-status') {
    const status = parts.find((part) => typeOf(part) === 'message/delivery-status');
    const recipients = (status ? groupsOf(status.body).slice(1) : []).flatMap((group) => {
      const address = recipientOf(group.get('final-recipient') ?? group.get('original-recipient'));
      if (!address) return [];
      return [{ address, action: (group.get('action') ?? '').toLowerCase(), status: group.get('status') ?? '', diagnostic: group.get('diagnostic-code') ?? null }];
    });
    return { messageId, kind: 'bounce', recipients };
  }
  if (reportType === 'feedback-report') {
    const feedback = parts.find((part) => typeOf(part) === 'message/feedback-report');
    const report = feedback ? (groupsOf(feedback.body)[0] ?? new Map<string, string>()) : new Map<string, string>();
    // The complainer: the report's Original-Rcpt-To, or the To of the message it reports.
    const original = parts.find((part) => ['message/rfc822', 'text/rfc822-headers'].includes(typeOf(part)));
    const originalTo = original ? headerOf(original.body).fields.find((field) => field.name === 'to')?.value : undefined;
    const address = recipientOf(report.get('original-rcpt-to')) ?? (originalTo ? recipientOf(/<([^>]+)>/.exec(originalTo)?.[1] ?? originalTo) : null);
    const ofMessage = messageId ?? (original ? (VERP.exec(original.body.toString('latin1'))?.[1]?.toLowerCase() ?? null) : null);
    return {
      messageId: ofMessage,
      kind: 'complaint',
      recipients: address ? [{ address, action: 'complained', status: '', diagnostic: null }] : [],
      feedbackType: (report.get('feedback-type') ?? 'abuse').toLowerCase(),
    };
  }
  return { messageId, kind: 'other', recipients: [] };
}

/** Whether a recipient's bounce is for good, which puts its address on the suppression list. */
export const isPermanent = (recipient: ReportedRecipient): boolean => recipient.action === 'failed' && /^5\./.test(recipient.status);
/** Whether a recipient bounced at all: failed, for good or for now; a delay is no bounce. */
export const isBounce = (recipient: ReportedRecipient): boolean => recipient.action === 'failed';

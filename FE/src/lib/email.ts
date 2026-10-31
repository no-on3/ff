import type { PillTone } from '../components/StatusPill';
import type { EmailAccount, EmailIdentity, EmailMessage, EmailMetrics, EmailRecipientStatus, IdentityStatus } from '../services/api';

/**
 * Customers' mail as the API gives it (ADR 0012): the fields, statuses and
 * words of the E-mail page. contract.test.ts compares the fields and the
 * statuses with the backend's DTOs and entities.
 */
export const IDENTITY_FIELDS = ['identity', 'type', 'status', 'sendingEnabled', 'dkimSelector', 'mailFromDomain', 'mailFromVerified', 'records', 'verifiedAt', 'createdAt'] as const;
export const EMAIL_ACCOUNT_FIELDS = ['sandbox', 'sendingEnabled', 'enforcementStatus', 'max24HourSend', 'maxSendRate', 'sentLast24Hours'] as const;
export const SUPPRESSION_FIELDS = ['address', 'reason', 'messageId', 'feedback', 'updatedAt'] as const;
export const MESSAGE_FIELDS = ['messageId', 'from', 'identity', 'status', 'recipients', 'sizeBytes', 'createdAt', 'sentAt'] as const;
export const RECIPIENT_FIELDS = ['address', 'status', 'diagnostic'] as const;
export const SEND_FIELDS = ['from', 'to', 'cc', 'bcc', 'replyTo', 'subject', 'text', 'html'] as const;
export const IDENTITY_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'TEMPORARY_FAILURE'] as const;
export const RECIPIENT_STATUSES = ['QUEUED', 'SENT', 'SUPPRESSED', 'BOUNCED', 'COMPLAINED', 'FAILED'] as const;

/** Each identity's status, as a pill says it. */
export const IDENTITY_STATUS_INFO: Record<IdentityStatus, { tone: PillTone; label: string; title: string }> = {
  PENDING: { tone: 'warn', label: 'Waiting', title: 'FF looks for its record every minute, for 72 hours; an address waits for its link to be followed' },
  SUCCESS: { tone: 'ok', label: 'Proved', title: 'Mail goes from it' },
  FAILED: { tone: 'failed', label: 'Not proved', title: 'Its record was not found within 72 hours: publish it, then check again' },
  TEMPORARY_FAILURE: { tone: 'failed', label: 'Record gone', title: 'Proved once, its record is gone since: no mail goes from it until it is back' },
};

/** What became of each recipient, in words. */
export const RECIPIENT_STATUS_INFO: Record<EmailRecipientStatus, { tone: PillTone; label: string }> = {
  QUEUED: { tone: 'warn', label: 'Queued' },
  SENT: { tone: 'ok', label: 'Sent' },
  SUPPRESSED: { tone: 'idle', label: 'Kept off: on the suppression list' },
  BOUNCED: { tone: 'failed', label: 'Bounced' },
  COMPLAINED: { tone: 'failed', label: 'Complained of' },
  FAILED: { tone: 'failed', label: 'Failed' },
};

/** What each record a domain publishes is for. */
export const RECORD_PURPOSES: Record<string, string> = {
  DKIM: 'Proves the domain: FF signs its mail with the key whose public half this is',
  MAIL_FROM: 'Brings its bounces back to FF, at its own return path',
  SPF: "Lets FF's mail server send for its return path",
  DMARC: 'Advised: receiving servers report what they see of its mail',
};

/** Why a domain or an address can't be added, or null: the API's own checks are the last word. */
export function identityProblem(text: string): string | null {
  const name = text.trim().toLowerCase();
  if (name === '') return 'A domain, such as shop.example.tn, or an address, such as orders@shop.example.tn';
  if (name.length > 320) return 'At most 320 characters';
  const at = name.lastIndexOf('@');
  const domain = at >= 0 ? name.slice(at + 1) : name;
  if (at === 0 || name.indexOf('@') !== at) return 'An address has one @, with something before it';
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return `${domain || 'The domain'} is not a domain, such as shop.example.tn`;
  return null;
}

/** Its sandbox, its switch and its standing, as one line; null when it sends as it should. */
export function sendingNotice(account: Pick<EmailAccount, 'sandbox' | 'sendingEnabled' | 'enforcementStatus'>): string | null {
  if (!account.sendingEnabled) return "FF's operator paused this account's sending: the SES endpoint refuses its messages. The e-mail to its owners says why.";
  if (account.enforcementStatus === 'SHUTDOWN') return "Its sending is stopped: its bounces or complaints went past what SES allows (10% and 0.5%). FF's operator reviews it.";
  if (account.enforcementStatus === 'PROBATION') return 'Its sending is under review: its bounces or complaints went past 5% or 0.1%. Clean its lists: past 10% or 0.5%, it stops.';
  if (account.sandbox) return "In the sandbox, as every new account is: mail goes only to the addresses and domains it proved. FF's operator lets it out once it says what it sends.";
  return null;
}

/** What it sent of its quota: "12 of 200 messages in the last 24 hours, 1 a second at most". */
export function quotaLabel(account: Pick<EmailAccount, 'sentLast24Hours' | 'max24HourSend' | 'maxSendRate'>): string {
  const count = (n: number) => n.toLocaleString('en-US');
  return `${count(account.sentLast24Hours)} of ${count(account.max24HourSend)} messages in the last 24 hours, ${count(account.maxSendRate)} a second at most`;
}

/** The addresses mail may go from: each proved address, and an address at each proved domain, which the sender names. */
export function senders(identities: EmailIdentity[]): string[] {
  return identities
    .filter((identity) => identity.status === 'SUCCESS')
    .map((identity) => (identity.type === 'DOMAIN' ? `noreply@${identity.identity}` : identity.identity));
}

/** Its recipients and what became of each, as one line: "ana@example.tn sent, gone@example.tn bounced". */
export function recipientsSummary(message: Pick<EmailMessage, 'recipients'>): string {
  return message.recipients.map((recipient) => `${recipient.address} ${RECIPIENT_STATUS_INFO[recipient.status]?.label.toLowerCase() ?? recipient.status}`).join(', ');
}

/** A list of addresses as typed: commas or spaces between them. */
export const addressList = (text: string): string[] =>
  text
    .split(/[\s,;]+/)
    .map((one) => one.trim())
    .filter((one) => one !== '');

/** The AWS CLI's send, from a terminal or a function's code, through FF's SES endpoint. */
export function sesCommand(from: string, to: string): string {
  return [
    'aws sesv2 send-email \\',
    `  --from-email-address ${from} \\`,
    `  --destination ToAddresses=${to} \\`,
    `  --content '{"Simple": {"Subject": {"Data": "Hello"}, "Body": {"Text": {"Data": "Sent through FF."}}}}'`,
  ].join('\n');
}

/** The last day's mail, from its hourly metrics, in words; and its reputation over 14 days, when it reached anyone. */
export function lastDayLabel({ metrics: m }: EmailMetrics): string {
  const count = (n: number) => n.toLocaleString('en-US');
  const sum = (series: number[]) => series.reduce((total, n) => total + n, 0);
  const latest = (series: Array<number | null>) => [...series].reverse().find((rate) => rate !== null) ?? null;
  const percent = (rate: number) => `${(Math.round(rate * 1000) / 10).toLocaleString('en-US')}%`;
  const sent = sum(m.Send.Sum);
  const day = sent === 0 ? 'Nothing sent in the last 24 hours' : `${count(sent)} sent in the last 24 hours, ${count(sum(m.Bounce.Sum))} bounced, ${count(sum(m.Complaint.Sum))} complained of`;
  const bounces = latest(m['Reputation.BounceRate'].Average);
  const complaints = latest(m['Reputation.ComplaintRate'].Average);
  if (bounces === null || complaints === null) return `${day}.`;
  return `${day}. Over 14 days, ${percent(bounces)} of its recipients bounced and ${percent(complaints)} complained: SES reviews past 5% and 0.1%.`;
}

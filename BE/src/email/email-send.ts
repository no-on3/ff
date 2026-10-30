import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { addressProblem, identityKey } from './email-names';

/**
 * A message as SES v2's SendEmail takes it (ADR 0012): its sender and its
 * recipients, each an address with a name or none, as RFC 5322 writes them;
 * simple content made into MIME as SES makes it; raw content read for its
 * sender and its recipients when the request doesn't name them, its Bcc header
 * taken out, as no recipient should see it.
 */

/** The most recipients a message has, To, Cc and Bcc together, as SES's. */
export const MAX_RECIPIENTS = 50;
/** The most a message is, as SES's raw messages: 10 MB. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** The headers FF writes for simple content, which the request's Headers can't set. */
const OWN_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'mime-version', 'content-type', 'content-transfer-encoding', 'return-path', 'dkim-signature', 'sender']);

/** The addresses of an address list, as a header or the API writes it ("Ana <orders@shop.tn>, b@shop.tn"), in lower case; null for one that is no address. */
export function addressesOf(text: string): Array<string | null> {
  return addressparser(text, { flatten: true }).map(({ address }) => {
    const key = identityKey(address ?? '');
    return key && addressProblem(key) === null ? key : null;
  });
}

/** The one address of a sender: "Ana <orders@shop.tn>" or orders@shop.tn; null for none, or more than one. */
export function senderOf(text: string): string | null {
  const addresses = addressesOf(text);
  return addresses.length === 1 ? addresses[0] : null;
}

/** Why a header of the request's can't be the message's, or null when it can. */
export function headerProblem(name: string, value: string): string | null {
  if (!/^[\x21-\x39\x3b-\x7e]{1,76}$/.test(name)) return `${JSON.stringify(name)} is not a header's name`;
  if (OWN_HEADERS.has(name.toLowerCase())) return `${name} is a header SES writes itself`;
  if (/[\r\n]/.test(value) || value.length > 870) return `${name}'s value is one line of 870 characters at most`;
  return null;
}

export interface SimpleContent {
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  subject: string;
  text?: string;
  html?: string;
  headers: Array<{ name: string; value: string }>;
}

/** Simple content as the message that goes: MIME, multipart when it has both bodies, its Message-ID the message's ID at the SES endpoint's host. */
export function composeSimple(content: SimpleContent, id: string, messageHost: string, date = new Date()): Promise<Buffer> {
  return new MailComposer({
    from: content.from,
    to: content.to,
    cc: content.cc,
    replyTo: content.replyTo,
    subject: content.subject,
    ...(content.text !== undefined ? { text: content.text } : {}),
    ...(content.html !== undefined ? { html: content.html } : {}),
    headers: content.headers.map(({ name, value }) => ({ key: name, value })),
    messageId: `<${id}@${messageHost}>`,
    date,
  })
    .compile()
    .build();
}

/** A raw message's header, its fields unfolded, by their names in lower case, in order; and where its body starts. */
export function headerOf(raw: Buffer): { fields: Array<{ name: string; value: string }>; end: number } {
  const text = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');
  const blank = /\r?\n\r?\n/.exec(text);
  const end = blank ? blank.index + blank[0].length : text.length;
  const fields: Array<{ name: string; value: string }> = [];
  for (const line of text.slice(0, blank ? blank.index : text.length).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1].value += ` ${line.trim()}`;
    else {
      const colon = line.indexOf(':');
      if (colon > 0) fields.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
    }
  }
  return { fields, end };
}

/** A header field's value's parameter, such as a Content-Type's boundary or report-type. */
export function headerParameter(value: string, name: string): string | null {
  const match = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
  return match ? (match[1] ?? match[2]) : null;
}

/** A MIME message's or part's parts, each its header fields, its body and the whole of it, split by its boundary; none when it isn't multipart. */
export function mimeParts(raw: Buffer): Array<{ fields: Array<{ name: string; value: string }>; body: Buffer; whole: Buffer }> {
  const { fields, end } = headerOf(raw);
  const boundary = headerParameter(fields.find((field) => field.name === 'content-type')?.value ?? '', 'boundary');
  if (!boundary) return [];
  const text = raw.subarray(end).toString('latin1');
  const delimiter = `--${boundary}`;
  return text
    .split(new RegExp(`\\r?\\n?${delimiter.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`))
    .slice(1, -1)
    .map((part) => {
      const buffer = Buffer.from(part, 'latin1');
      const header = headerOf(buffer);
      return { fields: header.fields, body: buffer.subarray(header.end), whole: buffer };
    });
}

/** A part named as a file's: a Content-Disposition's filename, or a Content-Type's name, RFC 2231's forms too. */
const NAMED = /;\s*(?:file)?name\*?[0-9*]*\s*=/i;

/**
 * What a message's attachments weigh as it is sent, their encoding with them:
 * SES bills these by the GB (its AttachmentsSize). A part is one when its
 * Content-Disposition says attachment or it is named as a file; a multipart
 * part's parts are looked into, ten deep at most.
 */
export function attachmentBytesOf(raw: Buffer, depth = 0): number {
  let bytes = 0;
  for (const part of mimeParts(raw)) {
    const value = (name: string) => part.fields.find((field) => field.name === name)?.value ?? '';
    const type = value('content-type');
    const disposition = value('content-disposition');
    if (/^\s*multipart\//i.test(type)) {
      if (depth < 10) bytes += attachmentBytesOf(part.whole, depth + 1);
    } else if (/^\s*attachment\b/i.test(disposition) || NAMED.test(disposition) || NAMED.test(type)) {
      bytes += part.body.length;
    }
  }
  return bytes;
}

/** A raw message's sender and recipients, as its header names them. */
export function rawParties(raw: Buffer): { from: string | null; to: string[]; cc: string[]; bcc: string[] } {
  const { fields } = headerOf(raw);
  const all = (name: string) => fields.filter((field) => field.name === name).map((field) => field.value);
  const list = (name: string) => all(name).flatMap(addressesOf) as string[];
  const from = all('from');
  return { from: from.length === 1 ? from[0] : null, to: list('to'), cc: list('cc'), bcc: list('bcc') };
}

/** The raw message without its Bcc header, which only the envelope carries. */
export function withoutBcc(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const blank = /\r?\n\r?\n/.exec(text);
  const head = blank ? text.slice(0, blank.index) : text;
  // A Bcc field and the lines that fold it; the header's last line keeps no line end, the blank line after it being the body's.
  const kept = head.replace(/^bcc:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim, '').replace(/\r?\n$/, '');
  if (kept === head) return raw;
  return Buffer.concat([Buffer.from(kept, 'latin1'), raw.subarray(Buffer.byteLength(head, 'latin1'))]);
}

/** Where a message's bounces come back: b-<id>@ its return-path domain, which names it. */
export const returnPathOf = (id: string, domain: string): string => `b-${id}@${domain}`;

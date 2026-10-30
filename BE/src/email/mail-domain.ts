import { generateKeyPair, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { DnsUnavailableError } from '../function-urls/domain-check';

/**
 * How a customer's domain sends mail through FF (ADR 0012): a DKIM key FF
 * makes for it, whose public half the domain publishes, as SES's "bring your
 * own DKIM" takes one; a return-path domain of its own, bounces.mail.<domain>,
 * whose MX record is FF's mail server, so that its bounces come back there;
 * and the SPF and DMARC records FF advises.
 */

/** A domain's DKIM key: its selector, the public half as its record's p= gives it, and the private half, PKCS #8 PEM. */
export interface DkimKey {
  selector: string;
  publicKey: string;
  privateKeyPem: string;
}

/** A new RSA key of 2,048 bits, as the spike measured one, and a selector of its own: ff and 8 hexadecimal characters. */
export function newDkimKey(): Promise<DkimKey> {
  return new Promise((resolve, reject) =>
    generateKeyPair('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }, (error, publicKey, privateKey) =>
      error ? reject(error) : resolve({ selector: `ff${randomBytes(4).toString('hex')}`, publicKey: publicKey.toString('base64'), privateKeyPem: privateKey }),
    ),
  );
}

/** A record the domain publishes, and what it is for. */
export interface MailRecord {
  purpose: 'DKIM' | 'MAIL_FROM' | 'SPF' | 'DMARC';
  type: 'TXT' | 'MX';
  name: string;
  value: string;
}

export const dkimRecordName = (domain: string, selector: string): string => `${selector}._domainkey.${domain}`;
export const dkimRecordValue = (publicKey: string): string => `v=DKIM1; k=rsa; p=${publicKey}`;
/** The domain's own return path: a message's bounce comes back to b-<message>@bounces.mail.<domain>. */
export const mailFromDomain = (domain: string): string => `bounces.mail.${domain}`;

/**
 * The records a domain publishes: its DKIM key, which proves it; the MX and
 * SPF records of its return-path domain, which bring its bounces back to FF's
 * mail server and say that server sends for it; and a DMARC policy to start
 * with, which only reports.
 */
export function mailDomainRecords(domain: string, selector: string, publicKey: string, mailHost: string): MailRecord[] {
  return [
    { purpose: 'DKIM', type: 'TXT', name: dkimRecordName(domain, selector), value: dkimRecordValue(publicKey) },
    { purpose: 'MAIL_FROM', type: 'MX', name: mailFromDomain(domain), value: `10 ${mailHost}` },
    { purpose: 'SPF', type: 'TXT', name: mailFromDomain(domain), value: `v=spf1 a:${mailHost} -all` },
    { purpose: 'DMARC', type: 'TXT', name: `_dmarc.${domain}`, value: 'v=DMARC1; p=none;' },
  ];
}

/** The DNS questions the check asks: an interface, so tests answer them. */
export interface MailResolver {
  /** The TXT records at the name, each one's strings joined. */
  txt(name: string): Promise<string[]>;
  /** The hosts of the name's MX records. */
  mx(name: string): Promise<string[]>;
}

const normal = (name: string) => name.toLowerCase().replace(/\.$/, '');
/** A DKIM record's public key, its p= tag without its spaces, as a record split in strings may have them. */
const publicKeyOf = (record: string): string | null => /(?:^|;)\s*p=([^;]*)/.exec(record)?.[1]?.replace(/\s+/g, '') ?? null;

/**
 * Whether the domain's DKIM record has its key, and its return-path domain's
 * MX record FF's mail server. Throws DnsUnavailableError when the DNS fails to
 * answer, which proves nothing either way.
 */
export async function checkMailDomain(resolver: MailResolver, domain: string, selector: string, publicKey: string, mailHost: string): Promise<{ dkim: boolean; mailFrom: boolean }> {
  const [records, exchanges] = await Promise.all([resolver.txt(dkimRecordName(domain, selector)), resolver.mx(mailFromDomain(domain))]);
  return { dkim: records.some((record) => publicKeyOf(record) === publicKey), mailFrom: exchanges.map(normal).includes(normal(mailHost)) };
}

/** Answers that mean "no such record", as opposed to failures. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

/** The resolver the backend uses: the system's, or the servers FF_DOMAIN_RESOLVERS names, as for customers' own domains. */
export class NodeMailResolver implements MailResolver {
  private readonly resolver: Resolver;

  constructor(servers: string[] = []) {
    this.resolver = new Resolver({ timeout: 3000, tries: 2 });
    if (servers.length > 0) this.resolver.setServers(servers);
  }

  async txt(name: string): Promise<string[]> {
    return (await this.ask(name, () => this.resolver.resolveTxt(name))).map((chunks) => chunks.join(''));
  }

  async mx(name: string): Promise<string[]> {
    return (await this.ask(name, () => this.resolver.resolveMx(name))).map((record) => record.exchange);
  }

  private async ask<T>(name: string, question: () => Promise<T[]>): Promise<T[]> {
    try {
      return await question();
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'ERROR';
      if (NO_RECORD.has(code)) return [];
      throw new DnsUnavailableError(name, code);
    }
  }
}

/**
 * A function URL's own domains, as the console shows them: each with the DNS
 * records that prove the account controls it, and where it stands. The API
 * checks the domain fully; the form only catches what is plainly no domain.
 * contract.test.ts ties the fields to the API's.
 */

export const DOMAIN_STATUSES = ['pending', 'verified'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export interface DomainRecord {
  type: 'CNAME' | 'TXT' | 'A' | 'AAAA';
  name: string;
  value: string;
}

/** The fields of a domain as the API answers them. */
export const CUSTOM_DOMAIN_FIELDS = ['domain', 'functionId', 'status', 'records', 'checkedAt', 'checkError', 'verifiedAt', 'createdAt'] as const;

export interface CustomDomain {
  domain: string;
  functionId: string;
  status: DomainStatus;
  /** Either set proves the domain: a CNAME to the URL's host, or the TXT record and the edge's addresses. */
  records: { cname: DomainRecord[]; txt: DomainRecord[] };
  checkedAt: string | null;
  /** What its last check found wrong. */
  checkError: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** What is plainly no domain, before the API's own check; null when it may be one. */
export function domainInputProblem(text: string): string | null {
  const name = text.trim().toLowerCase().replace(/\.$/, '');
  if (name === '') return 'Type a domain, such as shop.example.tn';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(name) || name.includes('/')) return 'A domain alone, without https:// or a path, such as shop.example.tn';
  if (!name.includes('.')) return 'A domain has two labels at least, such as example.tn';
  if (!/^[a-z0-9.-]+$/.test(name)) return 'A domain has letters, digits, hyphens and dots only';
  return null;
}

/** A record as a DNS provider's form asks for it. */
export const recordText = (record: DomainRecord): string => `${record.type}  ${record.name}  ${record.type === 'TXT' ? `"${record.value}"` : record.value}`;

/** Where the URL answers at a domain: its own scheme and port, the domain for its host. */
export function domainAddress(domain: string, functionUrl: string): string {
  const { protocol, port } = new URL(functionUrl);
  return `${protocol}//${domain}${port ? `:${port}` : ''}/`;
}

/** Where a domain stands, in a sentence. */
export function domainStatusText(domain: Pick<CustomDomain, 'domain' | 'status'>, functionUrl: string): string {
  if (domain.status !== 'verified') return 'Waiting for its DNS records: make one of the sets below, then check again.';
  const address = domainAddress(domain.domain, functionUrl);
  return `Verified: the URL answers at ${address}${address.startsWith('https:') ? ', its certificate made at the first request' : ''}.`;
}

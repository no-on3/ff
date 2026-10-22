import { Resolver } from 'node:dns/promises';

/**
 * How FF proves that an account controls a domain, before its function URL
 * answers there and the edge asks a certificate for it: by DNS, as the domain's
 * owner alone can change it. Either the domain is a CNAME to the URL's own host;
 * or, for a domain apex, which can't be a CNAME, a TXT record at
 * _ff-verify.<domain> holds the token FF gave, and the domain's addresses are
 * the edge's.
 */

/** The DNS questions the check asks: an interface, so tests answer them. */
export interface DomainResolver {
  /** The names the domain is a CNAME to; none when it is no CNAME. */
  cname(name: string): Promise<string[]>;
  /** The TXT records at the name, each one's strings joined. */
  txt(name: string): Promise<string[]>;
  /** The domain's IPv4 and IPv6 addresses. */
  addresses(name: string): Promise<string[]>;
}

/** The DNS didn't answer, or answered with an error: the check can say nothing, either way. */
export class DnsUnavailableError extends Error {
  constructor(name: string, code: string) {
    super(`The DNS didn't answer for ${name} (${code}): try again in a few minutes`);
    this.name = 'DnsUnavailableError';
  }
}

/** Answers that mean "no such record", as opposed to failures. */
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

/** The records a domain needs, as the API shows them to its account. */
export interface DomainRecord {
  type: 'CNAME' | 'TXT' | 'A' | 'AAAA';
  name: string;
  value: string;
}

/** The TXT record's value: the token, named, so that it reads as what it is in a zone. */
export const verificationValue = (token: string): string => `ff-verify=${token}`;

/** Where the TXT record goes. */
export const verificationName = (domain: string): string => `_ff-verify.${domain}`;

/**
 * The two ways to prove a domain: a CNAME to the URL's host, for a subdomain;
 * or the TXT record and the addresses of the edge, for any domain, an apex too.
 * Without the edge's addresses in the settings, only the TXT record.
 */
export function domainRecords(domain: string, urlHost: string, token: string, edgeAddresses: string[]): { cname: DomainRecord[]; txt: DomainRecord[] } {
  return {
    cname: [{ type: 'CNAME', name: domain, value: urlHost }],
    txt: [
      { type: 'TXT', name: verificationName(domain), value: verificationValue(token) },
      ...edgeAddresses.map((address): DomainRecord => ({ type: address.includes(':') ? 'AAAA' : 'A', name: domain, value: address })),
    ],
  };
}

const normal = (name: string) => name.toLowerCase().replace(/\.$/, '');

/** The outcome of a check: proved, or why not. */
export type DomainCheck = { verified: true; by: 'CNAME' | 'TXT' } | { verified: false; problem: string };

/**
 * Checks the domain's records. Throws DnsUnavailableError when the DNS fails to
 * answer, which proves nothing either way: a verified domain stays so.
 */
export async function checkDomain(
  resolver: DomainResolver,
  domain: string,
  urlHost: string,
  token: string,
  edgeAddresses: string[],
): Promise<DomainCheck> {
  const targets = (await resolver.cname(domain)).map(normal);
  if (targets.includes(normal(urlHost))) return { verified: true, by: 'CNAME' };
  if (targets.length > 0) {
    return { verified: false, problem: `${domain} is a CNAME to ${targets.join(', ')}, not to ${urlHost}` };
  }
  const values = await resolver.txt(verificationName(domain));
  if (!values.includes(verificationValue(token))) {
    return {
      verified: false,
      problem: `Neither a CNAME from ${domain} to ${urlHost}, nor a TXT record at ${verificationName(domain)} with "${verificationValue(token)}", was found`,
    };
  }
  if (edgeAddresses.length === 0) return { verified: true, by: 'TXT' };
  const addresses = await resolver.addresses(domain);
  if (addresses.length === 0) return { verified: false, problem: `${domain} has the TXT record, and no address: point it to ${edgeAddresses.join(', ')}` };
  const elsewhere = addresses.filter((address) => !edgeAddresses.includes(address));
  if (elsewhere.length > 0) {
    return { verified: false, problem: `${domain} points to ${elsewhere.join(', ')}, which is not FF's edge: point it to ${edgeAddresses.join(', ')} only` };
  }
  return { verified: true, by: 'TXT' };
}

/**
 * The resolver the backend uses: the system's, or the servers the settings
 * name (FF_DOMAIN_RESOLVERS), each question given a few seconds.
 */
export class NodeDomainResolver implements DomainResolver {
  private readonly resolver: Resolver;

  constructor(servers: string[] = []) {
    this.resolver = new Resolver({ timeout: 3000, tries: 2 });
    if (servers.length > 0) this.resolver.setServers(servers);
  }

  cname(name: string): Promise<string[]> {
    return this.ask(name, () => this.resolver.resolveCname(name));
  }

  async txt(name: string): Promise<string[]> {
    return (await this.ask(name, () => this.resolver.resolveTxt(name))).map((chunks) => chunks.join(''));
  }

  async addresses(name: string): Promise<string[]> {
    const [v4, v6] = await Promise.all([this.ask(name, () => this.resolver.resolve4(name)), this.ask(name, () => this.resolver.resolve6(name))]);
    return [...v4, ...v6];
  }

  /** The answer, none for a name or record that doesn't exist, and DnsUnavailableError for a failure. */
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

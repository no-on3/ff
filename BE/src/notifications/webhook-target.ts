import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** The longest webhook URL taken. */
export const MAX_URL_LENGTH = 2048;

/**
 * Addresses a webhook may never reach, so that a customer's URL can't make
 * FF call into its own network or machine: private, loopback, link-local,
 * shared, documentation, benchmarking, multicast and reserved ranges.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

/** Whether an address is one a webhook may never reach. BlockList checks an IPv4 address written as IPv6 (::ffff:10.0.0.1, ::ffff:a00:1) as IPv4. */
export function blockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return BLOCKED.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Why a webhook URL can't be taken, or null: http or https, a host, no user or password in it. */
export function webhookUrlProblem(text: string): string | null {
  if (text.length > MAX_URL_LENGTH) return `webhookUrl must be ${MAX_URL_LENGTH} characters at most`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'webhookUrl must be a URL, such as https://example.tn/ff-hooks';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'webhookUrl must be an http or https URL';
  if (url.username || url.password) return "webhookUrl mustn't hold a user or a password: check the signature instead";
  if (!url.hostname) return 'webhookUrl must name a host';
  return null;
}

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Where a webhook goes: its host's address, once every address the host has
 * was checked, so that the request reaches the address that was checked and
 * a second lookup can't send it elsewhere. Or why it can't go.
 */
export async function resolveWebhook(url: URL, allowPrivate: boolean, resolve: Lookup = systemLookup): Promise<{ address: string; family: 4 | 6 } | { problem: string }> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await resolve(host);
    } catch (error) {
      return { problem: `${host} could not be found (${(error as NodeJS.ErrnoException).code ?? 'no address'})` };
    }
  }
  if (addresses.length === 0) return { problem: `${host} has no address` };
  const blocked = addresses.find(({ address }) => blockedAddress(address));
  if (blocked && !allowPrivate) {
    return { problem: `${host} is ${blocked.address}, a private or reserved address: webhooks only go to the internet` };
  }
  const [first] = addresses;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

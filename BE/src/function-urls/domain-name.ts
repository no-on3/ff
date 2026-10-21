import { isIP } from 'node:net';

/**
 * A customer's own domain for a function URL, as an account may give it: a
 * host name of two labels at least, each 1 to 63 letters, digits and hyphens,
 * not starting or ending with a hyphen, 253 characters at most; compared in
 * lower case, without a final dot. Never an IP address, nor a name under the
 * function domain, which FF's own URLs use.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Names that never reach the internet's DNS, which no certificate authority certifies. */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'invalid', 'test', 'example', 'home.arpa'];

/** The domain as FF keeps it: lower case, without a final dot. */
export const domainKey = (domain: string): string => domain.trim().toLowerCase().replace(/\.$/, '');

/** Why a domain can't be a function URL's, or null when it can. `functionDomain` is FF's own, for its URLs. */
export function domainProblem(domain: string, functionDomain: string, { allowPrivate = false } = {}): string | null {
  const name = domainKey(domain);
  if (name.length === 0 || name.length > 253) return 'A domain has 1 to 253 characters';
  if (isIP(name) || isIP(name.replace(/^\[|\]$/g, ''))) return 'An IP address is no domain: give a name, such as api.example.tn';
  const labels = name.split('.');
  if (labels.length < 2) return 'A domain has two labels at least, such as example.tn';
  const bad = labels.find((label) => !LABEL.test(label));
  if (bad !== undefined) return `"${bad}" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen`;
  if (/^\d+$/.test(labels[labels.length - 1])) return 'A domain ends with a name, not a number';
  if (name === functionDomain || name.endsWith(`.${functionDomain}`)) return `${name} is under ${functionDomain}, where FF's own URLs are`;
  const suffix = PRIVATE_SUFFIXES.find((s) => name === s || name.endsWith(`.${s}`));
  if (suffix !== undefined && !allowPrivate) return `${name} is under .${suffix}, which no certificate authority certifies`;
  return null;
}

import { isIP } from 'node:net';
import { EmailIdentityType } from './email-identity.entity';

/**
 * The names customers' mail takes (ADR 0012): an identity, a domain or an
 * address, kept in lower case, as SES compares them.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** An address's local part, as mailbox providers take it: letters, digits and the punctuation RFC 5322 allows unquoted. */
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

/** The name as FF keeps it: trimmed, lower case, a domain without a final dot. */
export const identityKey = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

/** Why a name is no domain mail can go from, or null when it is one. */
export function mailDomainProblem(domain: string): string | null {
  if (domain.length === 0 || domain.length > 253) return 'A domain has 1 to 253 characters';
  if (isIP(domain) || isIP(domain.replace(/^\[|\]$/g, ''))) return 'An IP address is no domain: give a name, such as example.tn';
  const labels = domain.split('.');
  if (labels.length < 2) return 'A domain has two labels at least, such as example.tn';
  const bad = labels.find((label) => !LABEL.test(label));
  if (bad !== undefined) return `"${bad}" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen`;
  if (/^\d+$/.test(labels[labels.length - 1])) return 'A domain ends with a name, not a number';
  return null;
}

/** Why a name is no address mail can go to or from, or null when it is one. */
export function addressProblem(address: string): string | null {
  if (address.length > 320) return 'An address has 320 characters at most';
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return 'An address is a local part, @ and a domain, such as orders@example.tn';
  const local = address.slice(0, at);
  if (local.length > 64 || !LOCAL_PART.test(local)) return `"${local}" is not an address's local part: 64 letters, digits, dots and !#$%&'*+/=?^_\`{|}~- at most`;
  const problem = mailDomainProblem(address.slice(at + 1));
  return problem && `The address's domain: ${problem}`;
}

/** An identity, kept in lower case, and what it is; or why it is neither a domain nor an address. */
export function identityOf(name: string): { identity: string; type: EmailIdentityType } | { problem: string } {
  const identity = identityKey(name);
  if (identity.includes('@')) {
    const problem = addressProblem(identity);
    return problem ? { problem } : { identity, type: EmailIdentityType.EMAIL_ADDRESS };
  }
  const problem = mailDomainProblem(identity);
  return problem ? { problem } : { identity, type: EmailIdentityType.DOMAIN };
}

/** An address's domain. */
export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1);

import { randomInt } from 'node:crypto';

/**
 * Where a function URL lives: https://<id>.<the function domain>/, as AWS
 * Lambda's live at https://<id>.lambda-url.<region>.on.aws/. The function
 * domain is FF_FUNCTION_URL_BASE's host; the ID is the host's first label.
 */

/** A function URL's ID, as AWS Lambda's: 32 lowercase letters and digits. */
export const URL_ID = /^[a-z0-9]{32}$/;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new URL ID: 32 characters drawn at random, each as likely as the others. */
export function newUrlId(): string {
  return Array.from({ length: 32 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** The function domain: the base's host name, without its port. */
export function functionDomain(base: string): string {
  return new URL(base).hostname.toLowerCase();
}

/** A URL's address: the base's scheme and port, its ID before the host. */
export function urlAddress(base: string, urlId: string): string {
  const { protocol, host } = new URL(base);
  return `${protocol}//${urlId}.${host}/`;
}

/** A URL's host, without the base's port: what a customer's domain is a CNAME to. */
export function urlHost(base: string, urlId: string): string {
  return `${urlId}.${functionDomain(base)}`;
}

/** The host a request names, in lower case, without its port or a final dot; undefined without one, or for an IP address in brackets. */
export function hostName(host: string | undefined): string | undefined {
  if (!host || host.startsWith('[')) return undefined;
  const name = host.replace(/:\d*$/, '').toLowerCase().replace(/\.$/, '');
  return name || undefined;
}

/** The URL ID a request's host names under the function domain; undefined for any other host. */
export function urlIdOf(host: string | undefined, domain: string): string | undefined {
  const name = hostName(host);
  if (!name?.endsWith(`.${domain}`)) return undefined;
  const label = name.slice(0, -domain.length - 1);
  return URL_ID.test(label) ? label : undefined;
}

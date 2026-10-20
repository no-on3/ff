import type { Delivery } from '../services/api';

/** Every attempt a delivery gets, as the backend tries it: the first and 5 retries. */
export const MAX_ATTEMPTS = 6;

/** How a delivery went, as the page says it: a word, its tone, and what to know beside it. */
export interface Outcome {
  label: 'Sending' | 'Retrying' | 'Delivered' | 'Failed';
  tone: 'waiting' | 'ok' | 'failed';
  detail: string;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const tries = (n: number) => (n === 1 ? '1 try' : `${n} tries`);

/**
 * A delivery's outcome: sent, with the webhook's status; waiting for its
 * first try; waiting for the next one after a failure, with why and when; or
 * given up after its last try, with why.
 */
export function deliveryOutcome(delivery: Delivery): Outcome {
  if (delivery.status === 'delivered') {
    return { label: 'Delivered', tone: 'ok', detail: delivery.channel === 'webhook' && delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : 'Sent' };
  }
  if (delivery.status === 'failed') {
    return { label: 'Failed', tone: 'failed', detail: `${delivery.lastError ?? 'Not sent'}, after ${tries(delivery.attempts)}` };
  }
  if (delivery.attempts === 0 || !delivery.lastError) return { label: 'Sending', tone: 'waiting', detail: 'Within seconds' };
  const next = delivery.nextAttemptAt ? `; try ${delivery.attempts + 1} of ${MAX_ATTEMPTS} at ${clock(delivery.nextAttemptAt)}` : '';
  return { label: 'Retrying', tone: 'waiting', detail: `${delivery.lastError}${next}` };
}

/** Whether any delivery is still to be sent: the page then reads the list again shortly. */
export const anyPending = (deliveries: Delivery[]): boolean => deliveries.some((delivery) => delivery.status === 'pending');

export const channelLabel = (channel: Delivery['channel']): string => (channel === 'email' ? 'E-mail' : 'Webhook');

/** A test's webhook URL as the API takes it, or why not: http or https, without a user or password. Empty means none. */
export function testUrlProblem(text: string): string | null {
  if (!text.trim()) return null;
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return 'Enter a URL, such as https://example.tn/ff-hooks';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The URL must start with https:// or http://';
  if (url.username || url.password) return "The URL mustn't hold a user or a password: check the signature instead";
  return null;
}

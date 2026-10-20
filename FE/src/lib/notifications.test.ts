import { describe, expect, it } from 'vitest';
import type { Delivery } from '../services/api';
import { anyPending, channelLabel, deliveryOutcome, MAX_ATTEMPTS, testUrlProblem } from './notifications';

const DELIVERY: Delivery = {
  id: 'd-1',
  notificationId: 'n-1',
  kind: 'test',
  channel: 'webhook',
  target: 'https://example.tn/ff-hooks',
  status: 'pending',
  attempts: 0,
  lastError: null,
  responseStatus: null,
  createdAt: '2026-10-20T09:00:00.000Z',
  deliveredAt: null,
  nextAttemptAt: '2026-10-20T09:00:00.000Z',
};
const at = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

describe('a delivery, as the page says how it went', () => {
  it("delivered: a webhook's HTTP status, an e-mail sent", () => {
    expect(deliveryOutcome({ ...DELIVERY, status: 'delivered', attempts: 1, responseStatus: 204 })).toEqual({ label: 'Delivered', tone: 'ok', detail: 'HTTP 204' });
    expect(deliveryOutcome({ ...DELIVERY, channel: 'email', target: 'amira@ff.tn', status: 'delivered', attempts: 1 })).toEqual({ label: 'Delivered', tone: 'ok', detail: 'Sent' });
  });

  it('waiting for its first try, or being tried now: within seconds', () => {
    expect(deliveryOutcome(DELIVERY)).toEqual({ label: 'Sending', tone: 'waiting', detail: 'Within seconds' });
    // A backend took it: the attempt is counted, its outcome not known yet.
    expect(deliveryOutcome({ ...DELIVERY, attempts: 1 })).toEqual({ label: 'Sending', tone: 'waiting', detail: 'Within seconds' });
  });

  it('waiting after a failure: why, which try comes next and when', () => {
    expect(deliveryOutcome({ ...DELIVERY, attempts: 2, lastError: 'HTTP 500', responseStatus: 500, nextAttemptAt: '2026-10-20T09:03:00.000Z' })).toEqual({
      label: 'Retrying',
      tone: 'waiting',
      detail: `HTTP 500; try 3 of 6 at ${at('2026-10-20T09:03:00.000Z')}`,
    });
  });

  it('given up: why, after how many tries', () => {
    expect(deliveryOutcome({ ...DELIVERY, status: 'failed', attempts: 6, lastError: 'timed out after 5 s', nextAttemptAt: null })).toEqual({
      label: 'Failed',
      tone: 'failed',
      detail: 'timed out after 5 s, after 6 tries',
    });
    expect(deliveryOutcome({ ...DELIVERY, channel: 'email', status: 'failed', attempts: 1, lastError: 'FF_SMTP_URL is not set', nextAttemptAt: null }).detail).toBe(
      'FF_SMTP_URL is not set, after 1 try',
    );
  });

  it('reads the list again while one is still to be sent, and names the channels', () => {
    expect([anyPending([DELIVERY]), anyPending([{ ...DELIVERY, status: 'delivered' }, { ...DELIVERY, status: 'failed' }]), anyPending([])]).toEqual([true, false, false]);
    expect([channelLabel('email'), channelLabel('webhook'), MAX_ATTEMPTS]).toEqual(['E-mail', 'Webhook', 6]);
  });
});

describe("a test's webhook URL", () => {
  it('is none, or http or https without a user or password, as the API takes it', () => {
    expect([testUrlProblem(''), testUrlProblem('  '), testUrlProblem('https://example.tn/ff'), testUrlProblem(' http://localhost:8090/ff ')]).toEqual([null, null, null, null]);
    expect([testUrlProblem('example.tn/ff'), testUrlProblem('ftp://example.tn'), testUrlProblem('https://me:pw@example.tn')]).toEqual([
      'Enter a URL, such as https://example.tn/ff-hooks',
      'The URL must start with https:// or http://',
      "The URL mustn't hold a user or a password: check the signature instead",
    ]);
  });
});

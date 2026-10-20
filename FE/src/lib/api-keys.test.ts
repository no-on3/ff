import { describe, expect, it } from 'vitest';
import { EXPIRY_CHOICES, expiresAtFor, keyPrefix, keyState } from './api-keys';

describe('keyState', () => {
  const now = new Date('2026-10-17T12:00:00Z');

  it('shows a key without revocation or past expiry as active', () => {
    expect(keyState({ revokedAt: null, expiresAt: null }, now)).toBe('active');
    expect(keyState({ revokedAt: null, expiresAt: '2026-10-17T12:00:00.001Z' }, now)).toBe('active');
  });

  it('shows a key as expired from its expiry on, as the API stops it then', () => {
    expect(keyState({ revokedAt: null, expiresAt: '2026-10-17T12:00:00.000Z' }, now)).toBe('expired');
    expect(keyState({ revokedAt: null, expiresAt: '2026-10-01T00:00:00.000Z' }, now)).toBe('expired');
  });

  it('shows a revoked key as revoked, even once its expiry has passed', () => {
    expect(keyState({ revokedAt: '2026-10-02T00:00:00.000Z', expiresAt: '2026-10-03T00:00:00.000Z' }, now)).toBe('revoked');
  });
});

describe('expiresAtFor', () => {
  const now = new Date('2026-10-17T12:00:00Z');

  it('sends no expiry for a key that never expires', () => {
    expect(expiresAtFor(null, now)).toBeUndefined();
  });

  it('sends the expiry as ISO 8601, so many days from now', () => {
    expect(expiresAtFor(30, now)).toBe('2026-11-16T12:00:00.000Z');
    expect(expiresAtFor(365, now)).toBe('2027-10-17T12:00:00.000Z');
  });

  it("offers 'never' and expiries the API accepts, in the future", () => {
    expect(EXPIRY_CHOICES[0]).toEqual({ label: 'Never', days: null });
    for (const { days } of EXPIRY_CHOICES.slice(1)) expect(days).toBeGreaterThan(0);
  });
});

describe('keyPrefix', () => {
  it('shows a listed key by its ID, the part the API logs, never a secret', () => {
    expect(keyPrefix('0f3a9c21be47')).toBe('ffk_0f3a9c21be47_…');
  });
});

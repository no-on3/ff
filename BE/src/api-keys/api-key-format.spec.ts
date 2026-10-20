import { API_KEY, hashSecret, newApiKey, parseApiKey, secretMatches } from './api-key-format';

describe('API key format (L1, P-13, ADR 0004)', () => {
  it('makes keys of the exact format, which secret scanners can match', () => {
    const keys = Array.from({ length: 50 }, newApiKey);

    for (const { id, secret, key } of keys) {
      expect(key).toMatch(API_KEY);
      expect(key).toBe(`ffk_${id}_${secret}`);
      expect(id).toMatch(/^[0-9a-f]{12}$/);
      expect(secret).toHaveLength(43);
    }
    expect(new Set(keys.map((k) => k.secret)).size).toBe(50);
    expect(new Set(keys.map((k) => k.id)).size).toBe(50);
  });

  it('reads a key back into its ID and secret', () => {
    const { id, secret, key } = newApiKey();

    expect(parseApiKey(key)).toEqual({ id, secret });
  });

  it.each([
    ['a token', 'eyJhbGciOiJSUzI1NiJ9.e30.sig'],
    ['an uppercase key ID', `ffk_0123456789AB_${'a'.repeat(43)}`],
    ['a short secret', `ffk_0123456789ab_${'a'.repeat(42)}`],
    ['a long secret', `ffk_0123456789ab_${'a'.repeat(44)}`],
    ['a character outside base64url', `ffk_0123456789ab_${'a'.repeat(42)}+`],
    ['another prefix', `fk_0123456789ab_${'a'.repeat(43)}`],
  ])('refuses %s', (_label, value) => {
    expect(parseApiKey(value)).toBeUndefined();
  });

  it('keeps only a SHA-256 of the secret, and checks a secret against it', () => {
    const { secret } = newApiKey();
    const stored = hashSecret(secret);

    expect(stored).toHaveLength(32);
    expect(stored.toString('base64url')).not.toContain(secret);
    expect(secretMatches(secret, stored)).toBe(true);
    expect(secretMatches(`${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`, stored)).toBe(false);
    expect(secretMatches(secret, Buffer.alloc(16))).toBe(false); // a stored value of another length
  });
});

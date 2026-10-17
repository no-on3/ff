import {
  codeConfigMapName,
  codeHash,
  functionResourceName,
  accountHash,
  accountNamespace,
} from './naming';

describe('Kubernetes naming', () => {
  const id = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

  it('derives a deterministic 12-hex tenant hash without exposing the ID', () => {
    expect(accountHash('123456789012')).toMatch(/^[0-9a-f]{12}$/);
    expect(accountHash('123456789012')).toBe(accountHash('123456789012'));
    expect(accountHash('123456789012')).not.toBe(accountHash('210987654321'));
    expect(accountNamespace('ff-t-', '000000000001')).toMatch(/^ff-t-[0-9a-f]{12}$/);
  });

  it('names function resources fn-<id>, normalizing case', () => {
    expect(functionResourceName(id)).toBe(`fn-${id}`);
    expect(functionResourceName(id.toUpperCase())).toBe(`fn-${id}`);
  });

  it.each(['../etc', 'a_b', 'with space', '-leading', 'x'.repeat(41)])('rejects unsafe function ID %p', (bad) => {
    expect(() => functionResourceName(bad)).toThrow('cannot be used in a Kubernetes name');
  });

  it('gives each code version its own ConfigMap name within the 63-character limit', () => {
    const v1 = codeConfigMapName(id, codeHash('nodejs', 'a'));
    const v2 = codeConfigMapName(id, codeHash('nodejs', 'b'));

    expect(v1).not.toBe(v2);
    expect(v1.length).toBeLessThanOrEqual(63);
    expect(v1).toMatch(new RegExp(`^fn-${id}-[0-9a-f]{10}$`));
  });

  it('includes the runtime in the code hash', () => {
    expect(codeHash('nodejs', 'x')).not.toBe(codeHash('python', 'x'));
  });
});

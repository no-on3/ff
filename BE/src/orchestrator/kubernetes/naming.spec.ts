import {
  codeConfigMapName,
  codeHash,
  functionResourceName,
  tenantHash,
  tenantNamespace,
} from './naming';

describe('Kubernetes naming', () => {
  const id = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

  it('derives a deterministic 12-hex tenant hash without exposing the ID', () => {
    expect(tenantHash('user-1')).toMatch(/^[0-9a-f]{12}$/);
    expect(tenantHash('user-1')).toBe(tenantHash('user-1'));
    expect(tenantHash('user-1')).not.toBe(tenantHash('user-2'));
    expect(tenantNamespace('ff-t-', 'auth0|abc@example.com')).toMatch(/^ff-t-[0-9a-f]{12}$/);
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

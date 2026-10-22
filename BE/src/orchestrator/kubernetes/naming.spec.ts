import {
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

  it("hashes a version's code by its image and its runtime, each changing it", () => {
    const image = 'ff-dev-registry:5000/ff-code/123456789012@sha256:' + 'a'.repeat(64);

    expect(codeHash('nodejs', image)).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash('nodejs', image)).not.toBe(codeHash('nodejs', image.replace(/a$/, 'b')));
    expect(codeHash('nodejs', image)).not.toBe(codeHash('python', image));
  });
});

import { randomBytes } from 'node:crypto';
import { Sealed, UnsealError, open, seal } from './envelope';
import { DEVELOPMENT_KEY, KeyRing, parseKeyRing } from './key-ring';

const keyOf = (id: string) => ({ id, key: randomBytes(32) });
const line = (key: { id: string; key: Buffer }) => `${key.id}:${key.key.toString('base64')}`;

describe('the keys file', () => {
  it('reads one key a line, the first sealing, skipping blank lines and comments', () => {
    const [first, second] = [keyOf('2026-10'), keyOf('2026-01')];
    const { ring, problems } = parseKeyRing(`# FF's keys, newest first\n\n${line(first)}\n  ${line(second)}  \n`);

    expect(problems).toEqual([]);
    expect(ring!.current.id).toBe('2026-10');
    expect(ring!.current.key.equals(first.key)).toBe(true);
    expect(ring!.find('2026-01')!.key.equals(second.key)).toBe(true);
    expect(ring!.find('unknown')).toBeUndefined();
  });

  it('names the line of every problem, and never repeats a key', () => {
    const short = randomBytes(16).toString('base64');
    const { ring, problems } = parseKeyRing(
      [line(keyOf('a')), 'no-separator', `bad id!:${randomBytes(32).toString('base64')}`, `b:${short}`, `c:${randomBytes(32).toString('base64')}x`, line(keyOf('a'))].join('\n'),
    );

    expect(ring).toBeUndefined();
    expect(problems).toEqual([
      'line 2 must be <id>:<key>, the key 32 bytes in base64',
      'line 3: the ID must be 1 to 64 letters, digits, dots, hyphens or underscores',
      'line 4: the key "b" must be 32 bytes in base64, such as `openssl rand -base64 32` writes',
      'line 5: the key "c" must be 32 bytes in base64, such as `openssl rand -base64 32` writes',
      'line 6: the ID "a" is already used by an earlier line',
    ]);
    expect(problems.join(' ')).not.toContain(short);
  });

  it('refuses a file without any key', () => {
    expect(parseKeyRing('# nothing yet\n\n').problems).toEqual(['it holds no key']);
  });

  it('knows the development key wherever it is in the ring', () => {
    expect(new KeyRing([keyOf('a')]).holdsDevelopmentKey()).toBe(false);
    expect(new KeyRing([keyOf('a'), { id: 'copied', key: DEVELOPMENT_KEY.key }]).holdsDevelopmentKey()).toBe(true);
  });
});

describe('envelope encryption', () => {
  const ring = new KeyRing([keyOf('current'), keyOf('previous')]);
  const plaintext = Buffer.from(JSON.stringify({ variables: { DB_PASSWORD: 'hunter2' } }));

  it("opens what it sealed, in the same context, and the sealed value holds nothing in clear", () => {
    const sealed = seal(plaintext, 'function-1', ring);

    expect(sealed.kid).toBe('current');
    expect(open(sealed, 'function-1', ring).equals(plaintext)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('hunter2');
    expect(Buffer.from(sealed.data, 'base64').includes(Buffer.from('hunter2'))).toBe(false);
  });

  it('seals one value differently each time: a new data key and IV', () => {
    const [a, b] = [seal(plaintext, 'function-1', ring), seal(plaintext, 'function-1', ring)];

    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("doesn't open in another context: a row copied onto another function", () => {
    const sealed = seal(plaintext, 'function-1', ring);

    expect(() => open(sealed, 'function-2', ring)).toThrow(UnsealError);
  });

  it("doesn't open once any part was changed", () => {
    const sealed = seal(plaintext, 'function-1', ring);
    const flipped = (base64: string) => {
      const bytes = Buffer.from(base64, 'base64');
      bytes[bytes.length - 1] ^= 1;
      return bytes.toString('base64');
    };

    for (const field of ['key', 'iv', 'data', 'tag'] as const) {
      expect(() => open({ ...sealed, [field]: flipped(sealed[field]) }, 'function-1', ring)).toThrow(UnsealError);
    }
  });

  it("opens with an older key of the ring, and says when the key isn't there any more", () => {
    const older = new KeyRing([ring.find('previous')!]);
    const sealed = seal(plaintext, 'function-1', older);

    expect(open(sealed, 'function-1', ring).equals(plaintext)).toBe(true);
    expect(() => open(sealed, 'function-1', new KeyRing([keyOf('other')]))).toThrow(
      'The key "previous" that sealed it is not among the platform\'s keys',
    );
  });

  it("doesn't open with another key that has the same ID", () => {
    const sealed = seal(plaintext, 'function-1', ring);

    expect(() => open(sealed, 'function-1', new KeyRing([keyOf('current')]))).toThrow(UnsealError);
  });

  it('refuses a format it does not know', () => {
    const sealed = { ...seal(plaintext, 'function-1', ring), v: 2 } as unknown as Sealed;

    expect(() => open(sealed, 'function-1', ring)).toThrow('Unknown sealed format 2');
  });
});

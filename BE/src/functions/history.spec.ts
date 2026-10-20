import { HISTORY_FIELD_BYTES, keptJson, keptText, utf8Start } from './history';

const bytes = (text: string) => Buffer.byteLength(text);
/** A JSON string value whose JSON text (with its two quotes) is exactly `size` bytes of ASCII. */
const stringOfJsonSize = (size: number) => 'a'.repeat(size - 2);

describe('keptJson (P-45)', () => {
  it('keeps a value whose JSON text fits in 64 KiB as it is, the very same value, at exactly 64 KiB too', () => {
    const small = { name: 'Tunis', items: [1, 2, 3], nested: { ok: true } };
    const exact = stringOfJsonSize(HISTORY_FIELD_BYTES);

    expect(keptJson(small)).toEqual({ value: small, truncated: false });
    expect(keptJson(small).value).toBe(small);
    expect(keptJson(exact)).toEqual({ value: exact, truncated: false });
    expect(keptJson(null)).toEqual({ value: null, truncated: false });
  });

  it('keeps the first 64 KiB of the compact JSON text of a longer value, as a string, marked truncated', () => {
    const value = { data: 'x'.repeat(HISTORY_FIELD_BYTES), more: [1, 2] };

    const kept = keptJson(value);

    expect(kept.truncated).toBe(true);
    expect(kept.value).toBe(JSON.stringify(value).slice(0, HISTORY_FIELD_BYTES));
    expect(keptJson(stringOfJsonSize(HISTORY_FIELD_BYTES + 1)).truncated).toBe(true);
  });

  it.each([
    ['é', 2],
    ['€', 3],
    ['😀', 4],
  ])('cuts between two characters, never inside a %s (%i bytes), wherever the limit falls in it', (char, width) => {
    for (let shift = 0; shift < width; shift++) {
      const value = 'a'.repeat(shift) + char.repeat(Math.ceil(HISTORY_FIELD_BYTES / width) + 2);
      const text = JSON.stringify(value);

      const kept = keptJson(value).value as string;

      expect(bytes(kept)).toBeLessThanOrEqual(HISTORY_FIELD_BYTES);
      expect(bytes(kept)).toBeGreaterThan(HISTORY_FIELD_BYTES - width);
      expect(text.startsWith(kept)).toBe(true); // whole characters only: no U+FFFD at the cut
    }
  });

  it("keeps NUL and lone surrogates, which PostgreSQL's jsonb refuses, as U+FFFD, in values and keys alike, and leaves the input as it was", () => {
    const value = { name: 'a\u0000b', ['k\u0000']: 'emoji cut in two \ud83d', low: '\ude00 alone', pair: '😀', controls: '\u0001\u001f\n' };

    const kept = keptJson(value);

    expect(kept).toEqual({
      value: { name: 'a\ufffdb', ['k\ufffd']: 'emoji cut in two \ufffd', low: '\ufffd alone', pair: '😀', controls: '\u0001\u001f\n' },
      truncated: false,
    });
    expect(value.name).toBe('a\u0000b');
  });

  it('tells an escaped backslash followed by "u0000" from a NUL, and keeps the text as written', () => {
    expect(keptJson(['\\u0000', '\\\u0000', '\\ud800']).value).toEqual(['\\u0000', '\\\ufffd', '\\ud800']);
  });

  it('replaces those characters before measuring, in a value that is cut too', () => {
    const kept = keptJson('\u0000'.repeat(HISTORY_FIELD_BYTES));

    expect(kept.truncated).toBe(true);
    expect(kept.value).toBe(('"' + '\\ufffd'.repeat(HISTORY_FIELD_BYTES)).slice(0, HISTORY_FIELD_BYTES));
  });

  it('leaves no value as none', () => {
    expect(keptJson(undefined)).toEqual({ value: undefined, truncated: false });
  });
});

describe('keptText (P-45)', () => {
  it('keeps a text of up to 64 KiB as it is, NUL as U+FFFD', () => {
    expect(keptText('Error: bad input')).toEqual({ value: 'Error: bad input', truncated: false });
    expect(keptText('Error: a\u0000b')).toEqual({ value: 'Error: a\ufffdb', truncated: false });
    expect(keptText('é'.repeat(HISTORY_FIELD_BYTES / 2))).toEqual({ value: 'é'.repeat(HISTORY_FIELD_BYTES / 2), truncated: false });
  });

  it('keeps the first 64 KiB of a longer one, cut between two characters, marked truncated', () => {
    const kept = keptText('a' + '€'.repeat(HISTORY_FIELD_BYTES));

    expect(kept.truncated).toBe(true);
    expect(kept.value).toBe('a' + '€'.repeat((HISTORY_FIELD_BYTES - 1) / 3));
    expect(bytes(kept.value)).toBe(HISTORY_FIELD_BYTES);
  });
});

describe('utf8Start', () => {
  it('gives the whole text when it fits, and otherwise the longest start of whole characters', () => {
    expect(utf8Start('abc', 3)).toBe('abc');
    expect(utf8Start('a😀', 4)).toBe('a');
    expect(utf8Start('a😀', 5)).toBe('a😀');
    expect(utf8Start('😀', 3)).toBe('');
  });
});

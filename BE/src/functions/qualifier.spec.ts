/**
 * L1: a call's qualifier, as Lambda's: $LATEST, a version's number or an
 * alias's name; the version an alias's call runs, its share drawn; and the
 * calls a view keeps by what they named and what ran them.
 */
import { ALIAS_NAME } from './dto/aliases.dto';
import { QUALIFIER, callsKept, drawVersion, isFiltered, parseQualifier } from './qualifier';

describe("a call's qualifier (L1)", () => {
  it("takes $LATEST, a version's number and every alias's name, and nothing else", () => {
    for (const named of ['$LATEST', '1', '42', '999999999', 'prod', 'live_2', 'blue-green', '2a', 'a'.repeat(128)]) {
      expect([named, QUALIFIER.test(named)]).toEqual([named, true]);
    }
    // 0 and 01 are no version's; ten digits pass the table's integer; $latest is an alias's name Lambda refuses too.
    for (const refused of ['', '0', '01', '1234567890', '$latest', 'LATEST$', 'a.b', 'prod ', 'a'.repeat(129)]) {
      expect([refused, QUALIFIER.test(refused)]).toEqual([refused, false]);
    }
    // An alias's name is a qualifier: the two rules agree but on digits alone, a version's.
    for (const name of ['prod', 'x1', '_', 'a'.repeat(128)]) expect(ALIAS_NAME.test(name) && QUALIFIER.test(name)).toBe(true);
  });

  it('reads as $LATEST when missing or $LATEST, a version when digits, else an alias', () => {
    expect(parseQualifier(undefined)).toBeNull();
    expect(parseQualifier('$LATEST')).toBeNull();
    expect(parseQualifier('7')).toEqual({ version: 7 });
    expect(parseQualifier('prod')).toEqual({ alias: 'prod' });
    expect(parseQualifier('2a')).toEqual({ alias: '2a' });
  });
});

describe("an alias's draw (L1)", () => {
  const canary = { version: 3, additionalVersion: 4, additionalWeight: 0.1 };

  it("sends its share of the calls to its other version, the rest to its own, the share's boundary its own", () => {
    expect(drawVersion(canary, 0)).toBe(4);
    expect(drawVersion(canary, 0.0999)).toBe(4);
    expect(drawVersion(canary, 0.1)).toBe(3);
    expect(drawVersion(canary, 0.9999)).toBe(3);
  });

  it('gives a share of 1 every call, of 0 none; an alias of $LATEST runs $LATEST', () => {
    expect(drawVersion({ ...canary, additionalWeight: 1 }, 0.9999)).toBe(4);
    expect(drawVersion({ ...canary, additionalWeight: 0 }, 0)).toBe(3);
    expect(drawVersion({ version: null, additionalVersion: null, additionalWeight: null }, 0)).toBeUndefined();
    expect(drawVersion({ version: 2, additionalVersion: null, additionalWeight: null }, 0)).toBe(2);
  });

  it('draws for each call: about a tenth of a thousand calls go to the other version', () => {
    const drawn = Array.from({ length: 1000 }, () => drawVersion(canary)).filter((version) => version === 4).length;
    // 99.99 % of runs fall within: a binomial of 1,000 and 0.1 is 100 ± 9.5.
    expect(drawn).toBeGreaterThan(60);
    expect(drawn).toBeLessThan(140);
  });
});

describe('the calls a view keeps, by what they named and what ran them (L1)', () => {
  it('keeps every call when it names neither', () => {
    expect([callsKept({}), isFiltered({})]).toEqual([{}, false]);
  });

  it("keeps an alias's calls, whichever of its versions ran them", () => {
    expect(callsKept({ resource: 'live' })).toEqual({ alias: 'live' });
  });

  it('keeps the calls that named a version, or $LATEST, through no alias', () => {
    expect(callsKept({ resource: '3' })).toEqual({ version: 3, alias: null });
    expect(callsKept({ resource: '$LATEST' })).toEqual({ version: null, alias: null });
  });

  it('keeps the calls a version ran, or $LATEST, through an alias or not', () => {
    expect(callsKept({ executedVersion: '2' })).toEqual({ version: 2 });
    expect(callsKept({ executedVersion: '$LATEST' })).toEqual({ version: null });
  });

  it("keeps an alias's calls that one of its versions ran, as CloudWatch's two dimensions together", () => {
    expect(callsKept({ resource: 'live', executedVersion: '2' })).toEqual({ alias: 'live', version: 2 });
    expect(callsKept({ resource: '3', executedVersion: '3' })).toEqual({ version: 3, alias: null });
    expect(isFiltered({ executedVersion: '2' })).toBe(true);
  });

  it('keeps none when what a call named is not what ran it', () => {
    expect(callsKept({ resource: '3', executedVersion: '4' })).toBeUndefined();
    expect(callsKept({ resource: '$LATEST', executedVersion: '1' })).toBeUndefined();
    expect(callsKept({ resource: '1', executedVersion: '$LATEST' })).toBeUndefined();
  });
});

/**
 * L1: where an alias's calls may go, as Lambda's aliases: another version's
 * share as the row keeps it, and the routes Lambda refuses.
 */
import { BadRequestException } from '@nestjs/common';
import { routeRefusal, routingOf, versionNumber } from './aliases.service';
import { isVersionWeights } from './dto/aliases.dto';
import { namedByAliases } from './versions.service';

describe("an alias's route (L1)", () => {
  it('names $LATEST as none, a version by its number, and another version with its share, or none', () => {
    expect([versionNumber('$LATEST'), versionNumber('12')]).toEqual([null, 12]);
    expect(routingOf({ additionalVersionWeights: { '4': 0.25 } })).toEqual({ additionalVersion: 4, additionalWeight: 0.25 });
    expect(routingOf({ additionalVersionWeights: {} })).toEqual({ additionalVersion: null, additionalWeight: null });
  });

  it("takes one version's share, from 0 to 1, or none", () => {
    for (const weights of [{}, { '2': 0 }, { '2': 1 }, { '123456789': 0.5 }]) expect(isVersionWeights(weights)).toBe(true);
    for (const weights of [null, [], { '2': 0.1, '3': 0.2 }, { '2': -0.1 }, { '2': 1.01 }, { '2': '0.5' }, { '0': 0.5 }, { $LATEST: 0.5 }, { '02': 0.5 }]) {
      expect(isVersionWeights(weights)).toBe(false);
    }
  });

  it("refuses another version's share beside $LATEST and beside the alias's own version, as Lambda", () => {
    expect(routeRefusal({ version: 3, additionalVersion: 4, additionalWeight: 0.1 })).toBeUndefined();
    expect(routeRefusal({ version: null, additionalVersion: null, additionalWeight: null })).toBeUndefined();
    expect(routeRefusal({ version: null, additionalVersion: 4, additionalWeight: 0.1 })).toEqual(
      new BadRequestException("An alias of $LATEST can't share its calls with another version, as on Lambda: point it at a published version first"),
    );
    expect(routeRefusal({ version: 4, additionalVersion: 4, additionalWeight: 0.1 })?.message).toBe("routingConfig names version 4, the alias's own: name another version, or none");
  });

  it('names the aliases that keep a version from being deleted', () => {
    expect(namedByAliases({ name: 'orders' }, 3, ['live']).message).toBe('Version 3 of the function orders is named by its alias live: point it at another version, or delete it, first');
    expect(namedByAliases({ name: 'orders' }, 3, ['beta', 'live']).message).toBe(
      'Version 3 of the function orders is named by its aliases beta, live: point them at another version, or delete them, first',
    );
  });
});

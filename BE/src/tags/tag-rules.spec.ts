/** L1: what a resource's tags may be, as AWS says: their keys, their values, 50 a resource; and all of them, as a body gives them. */
import { TAG_LIMITS, allTagsProblem, tagsProblem } from './tag-rules';

describe('tag rules (L1)', () => {
  it("takes AWS's tags: letters of any language, digits, spaces and + - = . _ : / @, an empty value too", () => {
    expect(tagsProblem({}, { team: 'payments', 'cost-center': 'R&D'.replace('&', '+'), 'équipe / site': 'Tunis 1', 'a.b:c=d@e_f': '' })).toBeUndefined();
  });

  it("refuses no tag, a key empty or past 128 characters, AWS's aws: keys, a value past 256, and a character AWS doesn't take", () => {
    expect(tagsProblem({}, {})).toBe('Tags must hold at least one tag.');
    expect(tagsProblem({}, { '': 'x' })).toBe("A tag's key holds 1 to 128 characters: an empty one doesn't.");
    expect(tagsProblem({}, { ['k'.repeat(129)]: 'x' })).toMatch(/^A tag's key holds 1 to 128 characters: k{129} doesn't\.$/);
    expect(tagsProblem({}, { ['é'.repeat(128)]: 'x' })).toBeUndefined();
    expect(tagsProblem({}, { 'AWS:cloudformation': 'x' })).toBe('The key AWS:cloudformation starts with aws:, which AWS keeps for its own tags.');
    expect(tagsProblem({}, { team: 'v'.repeat(257) })).toBe("The value of team is longer than a tag's 256 characters.");
    expect(tagsProblem({}, { 'team#1': 'x' })).toBe("The key team#1 holds a character a tag can't: letters, digits, spaces and + - = . _ : / @ only.");
    expect(tagsProblem({}, { team: 'a;b' })).toBe("The value of team holds a character a tag can't: letters, digits, spaces and + - = . _ : / @ only.");
  });

  it('counts a key the resource has once, and refuses a 51st tag', () => {
    const fifty = Object.fromEntries(Array.from({ length: TAG_LIMITS.perResource }, (_, n) => [`k${n}`, 'v']));
    expect(tagsProblem(fifty, { k0: 'new value', k49: 'x' })).toBeUndefined();
    expect(tagsProblem(fifty, { k50: 'v' })).toBe('A resource has at most 50 tags: these would make it 51.');
  });

  it("takes all of a resource's tags as a body gives them, none among them, and refuses what isn't an object of strings", () => {
    expect([allTagsProblem({}), allTagsProblem({ team: 'orders' })]).toEqual([undefined, undefined]);
    expect([allTagsProblem(null), allTagsProblem(['team']), allTagsProblem('team=orders')]).toEqual(Array(3).fill("Tags are an object, each tag's value by its key."));
    expect(allTagsProblem({ team: 'orders', size: 3 })).toBe("The value of size is a string, as every tag's is.");
    expect(allTagsProblem({ 'aws:team': 'x' })).toBe('The key aws:team starts with aws:, which AWS keeps for its own tags.');
  });
});

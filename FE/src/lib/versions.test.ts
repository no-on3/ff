import { describe, expect, it } from 'vitest';
import {
  FunctionAlias,
  aliasBody,
  aliasesOn,
  aliasFormOf,
  callsChoices,
  callsText,
  emptyAliasForm,
  newestVersion,
  percentText,
  pickOf,
  pickValue,
  qualifierChoices,
  rollbackBody,
  rollbackTarget,
  routeText,
  runsText,
  shareOf,
  shortSha,
} from './versions';

const alias = (values: Partial<FunctionAlias> = {}): FunctionAlias => ({
  aliasArn: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders:live',
  name: 'live',
  functionVersion: '3',
  description: '',
  revisionId: 'r-1',
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
  ...values,
});
const versions = ['1', '2', '4'].map((version) => ({ version }));
const canary = alias({ routingConfig: { additionalVersionWeights: { '4': 0.125 } } });

describe("an alias's calls, in words", () => {
  it('says the version, $LATEST, and the share of the calls another version gets', () => {
    expect([routeText(alias()), routeText(alias({ functionVersion: '$LATEST' })), routeText(canary)]).toEqual([
      'Version 3',
      '$LATEST, the function as it is',
      'Version 3; 12.5% of its calls to version 4',
    ]);
    expect([shareOf(alias()), shareOf(canary), shareOf(alias({ routingConfig: { additionalVersionWeights: {} } }))]).toEqual([undefined, { version: '4', weight: 0.125 }, undefined]);
    expect([percentText(0.1), percentText(1), percentText(0)]).toEqual(['10%', '100%', '0%']);
  });

  it('names the aliases whose calls reach a version, with their part of them when they share them', () => {
    const aliases = [canary, alias({ name: 'beta', functionVersion: '4' }), alias({ name: 'next', functionVersion: '$LATEST' })];
    expect([aliasesOn('3', aliases), aliasesOn('4', aliases), aliasesOn('2', aliases), aliasesOn('$LATEST', aliases)]).toEqual([
      [{ name: 'live', label: 'live, 87.5%' }],
      [
        { name: 'live', label: 'live, 12.5%' },
        { name: 'beta', label: 'beta' },
      ],
      [],
      [{ name: 'next', label: 'next' }],
    ]);
  });

  it("shows a code's SHA-256 by its start", () => {
    expect(shortSha('n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=')).toBe('n4bQgYhMfWWa…');
  });
});

describe("an alias's form", () => {
  it('starts a new alias on the newest version, else $LATEST, and fills a change from the alias', () => {
    expect([emptyAliasForm(versions).version, emptyAliasForm([]).version]).toEqual(['4', '$LATEST']);
    expect(aliasFormOf(canary)).toEqual({ name: 'live', version: '3', shareVersion: '4', sharePercent: '12.5', description: '' });
  });

  it("sends Lambda's names: a new alias's name and no share when it has none; a change {} to clear the share", () => {
    expect(aliasBody({ name: ' live ', version: '3', shareVersion: '', sharePercent: '', description: ' The shop ' }, true)).toEqual({
      body: { name: 'live', functionVersion: '3', description: 'The shop' },
    });
    expect(aliasBody({ name: 'live', version: '3', shareVersion: '4', sharePercent: '10', description: '' }, true)).toEqual({
      body: { name: 'live', functionVersion: '3', description: '', routingConfig: { additionalVersionWeights: { '4': 0.1 } } },
    });
    expect(aliasBody({ name: 'live', version: '$LATEST', shareVersion: '', sharePercent: '', description: '' }, false)).toEqual({
      body: { functionVersion: '$LATEST', description: '', routingConfig: { additionalVersionWeights: {} } },
    });
  });

  it.each([
    ['a name of digits alone', { name: '12' }, "The name has 1 to 128 letters, digits, '-' and '_', and isn't digits alone, which name a version"],
    ['a name with a space', { name: 'my alias' }, "The name has 1 to 128 letters, digits, '-' and '_', and isn't digits alone, which name a version"],
    ['a share beside $LATEST', { version: '$LATEST', shareVersion: '4', sharePercent: '10' }, 'A share of the calls goes beside a version: an alias naming $LATEST has none, as on Lambda'],
    ['a share to its own version', { shareVersion: '3', sharePercent: '10' }, "The share goes to another version than the alias's own"],
    ['a share past 100%', { shareVersion: '4', sharePercent: '101' }, 'The share is a percentage of the calls, from 0 to 100'],
    ['a share left empty', { shareVersion: '4', sharePercent: ' ' }, 'The share is a percentage of the calls, from 0 to 100'],
  ])('says what is wrong: %s', (_case, fields, problem) => {
    expect(aliasBody({ name: 'live', version: '3', shareVersion: '', sharePercent: '', description: '', ...fields }, true)).toEqual({ problem });
  });
});

describe('a rollback in one move', () => {
  it('points an alias back to the newest version before its own that is still there, with its revision, the share gone', () => {
    expect([rollbackTarget(alias(), versions), rollbackTarget(alias({ functionVersion: '4' }), versions), rollbackTarget(alias({ functionVersion: '1' }), versions)]).toEqual([
      '2',
      '2',
      undefined,
    ]);
    expect(rollbackTarget(alias({ functionVersion: '$LATEST' }), versions)).toBeUndefined();
    expect(rollbackBody(canary, '2')).toEqual({ functionVersion: '2', routingConfig: { additionalVersionWeights: {} }, revisionId: 'r-1' });
    expect([newestVersion(versions), newestVersion([])]).toEqual(['4', undefined]);
  });
});

describe('what a schedule or a queue reader runs', () => {
  it('says the version or the alias it runs, and nothing for the function as it is', () => {
    expect([runsText('3'), runsText('live'), runsText(null), runsText('$LATEST'), runsText(undefined)]).toEqual(['Runs version 3', 'Runs alias live', null, null, null]);
  });

  it('offers $LATEST, each alias with where it goes, each version newest first, and keeps one deleted since', () => {
    expect(qualifierChoices(versions, [canary, alias({ name: 'beta', functionVersion: '$LATEST' })], 'gone')).toEqual([
      { value: '', label: '$LATEST, the function as it is' },
      { value: 'beta', label: 'Alias beta: $LATEST, the function as it is' },
      { value: 'live', label: 'Alias live: Version 3; 12.5% of its calls to version 4' },
      { value: '4', label: 'Version 4' },
      { value: '2', label: 'Version 2' },
      { value: '1', label: 'Version 1' },
      { value: 'gone', label: 'Alias gone, deleted since' },
    ]);
    expect(qualifierChoices([], [], '7')).toEqual([
      { value: '', label: '$LATEST, the function as it is' },
      { value: '7', label: 'Version 7, deleted since' },
    ]);
  });
});

describe("some of a function's calls, as CloudWatch's Resource and ExecutedVersion pick them", () => {
  it('offers every call, those through each alias, naming each version or neither, and run by each version or $LATEST, keeping one gone since', () => {
    expect(callsChoices(versions.slice(0, 2), [canary, alias({ name: 'beta' })], { resource: 'gone', executedVersion: '9' })).toEqual([
      { value: '|', label: 'Every call' },
      { value: 'beta|', label: 'Through alias beta' },
      { value: 'live|', label: 'Through alias live' },
      { value: '2|', label: 'Naming version 2' },
      { value: '1|', label: 'Naming version 1' },
      { value: '$LATEST|', label: 'Naming no alias or version: $LATEST' },
      { value: '|2', label: 'Run by version 2, however named' },
      { value: '|1', label: 'Run by version 1, however named' },
      { value: '|$LATEST', label: 'Run by $LATEST, however named' },
      { value: 'gone|9', label: 'Calls through alias gone, run by version 9' },
    ]);
  });

  it('says them in words, and goes to and from a select\'s value', () => {
    expect([
      callsText({ resource: 'live', executedVersion: '' }),
      callsText({ resource: '3', executedVersion: '3' }),
      callsText({ resource: '$LATEST', executedVersion: '' }),
      callsText({ resource: '', executedVersion: '$LATEST' }),
      callsText({ resource: '', executedVersion: '' }),
    ]).toEqual(['calls through alias live', 'calls naming version 3, run by version 3', 'calls naming no alias or version', 'calls run by $LATEST', null]);
    expect([pickValue({ resource: 'live', executedVersion: '2' }), pickOf('live|2'), pickOf('|')]).toEqual(['live|2', { resource: 'live', executedVersion: '2' }, { resource: '', executedVersion: '' }]);
  });
});

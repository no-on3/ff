import { describe, expect, it } from 'vitest';
import { MAX_ENVIRONMENT_BYTES, environmentBytes, environmentOf, environmentProblems, nameProblem, rowsOf, sameEnvironment, secretProblem } from './environment';

describe("a function's environment variables in the console", () => {
  it('shows them as rows, by name, and sends them back as a map, without the rows left empty', () => {
    const rows = rowsOf({ ZETA: '1', ALPHA: '2' });

    expect(rows).toEqual([
      { name: 'ALPHA', value: '2' },
      { name: 'ZETA', value: '1' },
    ]);
    expect(environmentOf([...rows, { name: '', value: '' }, { name: ' TRIMMED ', value: ' kept as typed ' }])).toEqual({
      ALPHA: '2',
      ZETA: '1',
      TRIMMED: ' kept as typed ',
    });
    expect(rowsOf(undefined)).toEqual([]);
  });

  it('holds names to the API rules: a letter first, two characters, nothing reserved', () => {
    expect(nameProblem('TABLE_NAME')).toBeUndefined();
    expect(nameProblem('TZ')).toBeUndefined();
    expect(nameProblem('X')).toMatch(/is not a variable name/);
    expect(nameProblem('1ST')).toMatch(/is not a variable name/);
    expect(nameProblem('MY-VAR')).toMatch(/is not a variable name/);
    expect(nameProblem('AWS_REGION')).toBe("AWS_REGION is reserved: AWS Lambda or FF's runtime sets it");
    expect(nameProblem('PATH')).toBe("PATH is reserved: AWS Lambda or FF's runtime sets it");
    expect(nameProblem('FF_ANYTHING')).toBe("FF_ANYTHING is reserved: names starting with FF_ are FF's own");
  });

  it('says what keeps the rows from being saved: a name twice, a value without a name, a secret\'s name', () => {
    expect(
      environmentProblems(
        [
          { name: 'TABLE', value: 'a' },
          { name: 'TABLE', value: 'b' },
          { name: '', value: 'orphan' },
          { name: 'DB_PASSWORD', value: 'x' },
          { name: '', value: '' },
        ],
        ['DB_PASSWORD'],
      ),
    ).toEqual(['TABLE is there twice', 'Every variable needs a name', 'DB_PASSWORD is a secret already: a name is a variable or a secret, not both']);
    expect(environmentProblems([{ name: 'TABLE', value: 'orders' }])).toEqual([]);
  });

  it('counts 4 KB as AWS Lambda does: the bytes of the JSON text', () => {
    // {"BIG":"…"} is 10 bytes around the value; é is two bytes.
    expect(environmentBytes({ BIG: 'x'.repeat(MAX_ENVIRONMENT_BYTES - 10) })).toBe(4096);
    expect(environmentBytes({ BIG: 'é' })).toBe(12);
    expect(environmentProblems([{ name: 'BIG', value: 'x'.repeat(MAX_ENVIRONMENT_BYTES - 10) }])).toEqual([]);
    expect(environmentProblems([{ name: 'BIG', value: 'x'.repeat(MAX_ENVIRONMENT_BYTES - 9) }])).toEqual([
      'The variables are 4097 bytes as JSON text: AWS Lambda allows 4096 (4 KB)',
    ]);
  });

  it('knows an unchanged map, whatever the order', () => {
    expect(sameEnvironment({ A: '1', B: '2' }, { B: '2', A: '1' })).toBe(true);
    expect(sameEnvironment({ A: '1' }, { A: '2' })).toBe(false);
    expect(sameEnvironment({ A: '1' }, { A: '1', B: '' })).toBe(false);
  });
});

describe("a function's secrets in the console", () => {
  it("are set under a name the API takes, which isn't a variable's, and with a value typed", () => {
    expect(secretProblem('DB_PASSWORD', 'hunter2', ['DB_USER'])).toBeUndefined();
    expect(secretProblem('DB_USER', 'x', ['DB_USER'])).toBe('DB_USER is a variable already: a name is a variable or a secret, not both');
    expect(secretProblem('AWS_SECRET_ACCESS_KEY', 'x', [])).toBe("AWS_SECRET_ACCESS_KEY is reserved: AWS Lambda or FF's runtime sets it");
    expect(secretProblem('DB_PASSWORD', '', [])).toBe('Type the value: it is never shown again');
  });
});

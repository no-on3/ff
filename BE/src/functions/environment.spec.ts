import { NO_ENVIRONMENT, changedSecrets, combinedProblems, nameProblem, processEnvironment, secretsView, storedSecrets, withSecrets } from './environment';

describe("a function's secrets", () => {
  const then = new Date('2026-10-21T08:00:00.000Z');
  const now = new Date('2026-10-21T09:00:00.000Z');
  const kept = { DB_PASSWORD: { value: 'old', updatedAt: then.toISOString() }, API_TOKEN: { value: 'tok', updatedAt: then.toISOString() } };

  it('are kept with the time they were set', () => {
    expect(storedSecrets({ DB_PASSWORD: 'x' }, now)).toEqual({ DB_PASSWORD: { value: 'x', updatedAt: '2026-10-21T09:00:00.000Z' } });
  });

  it('change by name: a new value is set now, null removes, the others stay as they were', () => {
    const { secrets, changed } = changedSecrets(kept, { DB_PASSWORD: 'new', API_TOKEN: null, NEW_ONE: 'n' }, now);

    expect(changed).toBe(true);
    expect(secrets).toEqual({
      DB_PASSWORD: { value: 'new', updatedAt: now.toISOString() },
      NEW_ONE: { value: 'n', updatedAt: now.toISOString() },
    });
    expect(kept.API_TOKEN).toBeDefined(); // the secrets given are not changed in place
  });

  it("change nothing for a value already set or a name already gone, keeping when it was set", () => {
    const { secrets, changed } = changedSecrets(kept, { DB_PASSWORD: 'old', GONE: null }, now);

    expect(changed).toBe(false);
    expect(secrets).toEqual(kept);
  });

  it('go to the process with the variables, as variables', () => {
    expect(processEnvironment({ variables: { TABLE: 'orders' }, secrets: kept })).toEqual({ TABLE: 'orders', DB_PASSWORD: 'old', API_TOKEN: 'tok' });
  });

  it("can't share a name with a variable, nor make more than 4 KB with them, as Lambda counts its variables", () => {
    expect(combinedProblems({ variables: { DB_PASSWORD: 'x', TABLE: 'o' }, secrets: kept })).toEqual([
      'DB_PASSWORD is both a variable and a secret: a name is one or the other',
    ]);
    // {"BIG":"…","DB_PASSWORD":"old","API_TOKEN":"tok"} is 48 bytes around the value.
    const big = (n: number) => ({ variables: { BIG: 'x'.repeat(n) }, secrets: kept });
    expect(combinedProblems(big(4096 - 48))).toEqual([]);
    expect(combinedProblems(big(4096 - 47))).toEqual([
      "The environment is 4097 bytes as JSON text: AWS Lambda allows 4096 (4 KB) for a function's variables and secrets together",
    ]);
  });

  it('are said by name and date, sorted, never by value', () => {
    const view = secretsView({ variables: {}, secrets: kept });

    expect(view).toEqual({ secrets: [{ name: 'API_TOKEN', updatedAt: then.toISOString() }, { name: 'DB_PASSWORD', updatedAt: then.toISOString() }] });
    expect(JSON.stringify(view)).not.toMatch(/old|tok"/);
  });

  it('give a new revision when there is anything, none when nothing is left', () => {
    expect(withSecrets(NO_ENVIRONMENT, kept).revision).toMatch(/^[0-9a-f]{16}$/);
    expect(withSecrets({ ...NO_ENVIRONMENT, secrets: kept, revision: 'r' }, {}).revision).toBe('');
  });
});

describe("a variable's name", () => {
  it("is FF's when FF sets it, with the function's own key: its account's buckets and queues", () => {
    expect(nameProblem('AWS_ENDPOINT_URL_S3')).toBe("AWS_ENDPOINT_URL_S3 is reserved: FF sets it, with the function's own key to its account's buckets");
    expect(nameProblem('AWS_ENDPOINT_URL_SQS')).toBe("AWS_ENDPOINT_URL_SQS is reserved: FF sets it, with the function's own key to its account's queues");
  });

  it('is anyone\'s otherwise, a name every object inherits too, such as constructor', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', 'AWS_ENDPOINT_URL_DYNAMODB']) expect(nameProblem(name)).toBeUndefined();
  });
});
